package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/netip"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"tailscale.com/health"
	"tailscale.com/net/dns/resolver"
	"tailscale.com/net/netmon"
	"tailscale.com/net/tsdial"
	"tailscale.com/types/dnstype"
	"tailscale.com/types/logger"
	"tailscale.com/util/dnsname"
)

// A subnet nameserver can share an address with a different nameserver on the
// host network. Both DNS transports must follow the userspace route, including
// the UDP attempt raced against TCP for LocalAPI DNS queries.
func TestSplitDNSForwarderDoesNotQueryHostNetwork(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	localDNS, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	resolverAddress := localDNS.LocalAddr().(*net.UDPAddr).AddrPort()
	var hostQueries atomic.Int32
	udpAttempted := make(chan struct{})
	var udpOnce sync.Once
	noteUDP := func() { udpOnce.Do(func() { close(udpAttempted) }) }
	hostDone := make(chan struct{})
	go func() {
		defer close(hostDone)
		packet := make([]byte, 4096)
		for {
			n, from, err := localDNS.ReadFromUDPAddrPort(packet)
			if err != nil {
				return
			}
			hostQueries.Add(1)
			noteUDP()
			response, err := splitDNSForwarderResponse(packet[:n], "198.51.100.80")
			if err == nil {
				localDNS.WriteToUDPAddrPort(response, from)
			}
		}
	}()
	t.Cleanup(func() {
		localDNS.Close()
		<-hostDone
	})

	netMon := netmon.NewStatic()
	t.Cleanup(func() { netMon.Close() })
	dialer := tsdial.NewDialer(netMon)
	t.Cleanup(func() { dialer.Close() })
	dialer.UseNetstackForIP = func(ip netip.Addr) bool { return ip == resolverAddress.Addr() }
	dialRouted := func(dialCtx context.Context, address netip.AddrPort, tcp bool) (net.Conn, error) {
		if address != resolverAddress {
			return nil, fmt.Errorf("unexpected resolver address: %s", address)
		}
		if tcp {
			// Prevent a fast TCP answer from hiding an incorrectly routed UDP
			// attempt. Either UDP path releases this gate without a sleep.
			select {
			case <-udpAttempted:
			case <-dialCtx.Done():
				return nil, dialCtx.Err()
			}
		}
		client, server := net.Pipe()
		stop := context.AfterFunc(dialCtx, func() {
			client.Close()
			server.Close()
		})
		go func() {
			defer server.Close()
			defer stop()
			packet := make([]byte, 4096)
			var n int
			var err error
			if tcp {
				var length uint16
				if err = binary.Read(server, binary.BigEndian, &length); err != nil {
					return
				}
				packet = make([]byte, length)
				n, err = io.ReadFull(server, packet)
			} else {
				n, err = server.Read(packet)
				if err == nil {
					noteUDP()
				}
			}
			if err != nil {
				return
			}
			response, err := splitDNSForwarderResponse(packet[:n], "192.0.2.80")
			if err != nil {
				return
			}
			if tcp {
				if err := binary.Write(server, binary.BigEndian, uint16(len(response))); err != nil {
					return
				}
			}
			server.Write(response)
		}()
		return client, nil
	}
	dialer.NetstackDialUDP = func(ctx context.Context, address netip.AddrPort) (net.Conn, error) {
		return dialRouted(ctx, address, false)
	}
	dialer.NetstackDialTCP = func(ctx context.Context, address netip.AddrPort) (net.Conn, error) {
		return dialRouted(ctx, address, true)
	}
	dnsResolver := resolver.New(logger.Discard, nil, dialer, new(health.Tracker), nil)
	t.Cleanup(func() { dnsResolver.Close() })
	if err := dnsResolver.SetConfig(resolver.Config{
		AcceptDNS: true,
		Routes: map[dnsname.FQDN][]*dnstype.Resolver{
			"internal.example.com.": {{Addr: resolverAddress.String()}},
		},
	}); err != nil {
		t.Fatal(err)
	}
	query := func(ctx context.Context, name, queryType string) ([]byte, error) {
		if queryType != "A" {
			return nil, fmt.Errorf("unexpected query type: %s", queryType)
		}
		message := dnsmessage.Message{
			Header: dnsmessage.Header{ID: 1, RecursionDesired: true},
			Questions: []dnsmessage.Question{{
				Name: dnsmessage.MustNewName(name), Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET,
			}},
		}
		packet, err := message.Pack()
		if err != nil {
			return nil, err
		}
		// Match LocalAPI QueryDNS: TCP permits full replies, but the
		// embedded resolver still attempts upstream UDP as well.
		return dnsResolver.Query(ctx, packet, "tcp", netip.AddrPort{})
	}
	ips, err := lookupSplitDNS(ctx, "tcp4", "service.internal.example.com", query)
	if err != nil {
		t.Errorf("lookupSplitDNS: %v", err)
	}
	if want := []netip.Addr{netip.MustParseAddr("192.0.2.80")}; !slices.Equal(ips, want) {
		t.Errorf("resolved addresses = %v, want routed answer %v", ips, want)
	}
	if count := hostQueries.Load(); count != 0 {
		t.Errorf("restricted DNS queries sent through host UDP = %d, want 0", count)
	}
}

func splitDNSForwarderResponse(packet []byte, address string) ([]byte, error) {
	var message dnsmessage.Message
	if err := message.Unpack(packet); err != nil {
		return nil, err
	}
	if len(message.Questions) != 1 || message.Questions[0].Type != dnsmessage.TypeA {
		return nil, fmt.Errorf("expected one A question")
	}
	message.Response = true
	message.RecursionAvailable = true
	message.Answers = []dnsmessage.Resource{testDNSAddress(message.Questions[0].Name.String(), address)}
	return message.Pack()
}
