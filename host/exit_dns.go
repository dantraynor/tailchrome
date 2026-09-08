package main

import (
	"bytes"
	"context"
	"fmt"
	"golang.org/x/net/dns/dnsmessage"
	"io"
	"net"
	"net/http"
	"net/netip"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/types/dnstype"
	"tailscale.com/types/netmap"
)

// Exit DNS remains active when accepting the tailnet's DNS configuration is off.
// Capture the selected peer's literal endpoint and never use the system resolver
// or follow an HTTP redirect. Returned addresses still require destination checks.
func queryExitProxyDNS(ctx context.Context, nm *netmap.NetworkMap, exitNodeID, network, hostname string, dial func(context.Context, string, string) (net.Conn, error)) ([]netip.Addr, error) {
	host, valid := dnsName(hostname)
	if !valid || nm == nil || exitNodeID == "" {
		return nil, errProxyDestinationDenied
	}
	for _, peer := range nm.Peers {
		if !peer.Valid() || string(peer.StableID()) != exitNodeID {
			continue
		}
		if endpoint := exitProxyDNSEndpoint(nm, peer); endpoint != "" {
			transport := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				if address != endpoint {
					return nil, errProxyDestinationDenied
				}
				return dial(ctx, network, endpoint)
			}, DisableKeepAlives: true}
			defer transport.CloseIdleConnections()
			client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			var addresses []netip.Addr
			name, err := dnsmessage.NewName(host + ".")
			if err != nil {
				return nil, errProxyDestinationDenied
			}
			for _, kind := range []dnsmessage.Type{dnsmessage.TypeA, dnsmessage.TypeAAAA} {
				question := dnsmessage.Question{Name: name, Type: kind, Class: dnsmessage.ClassINET}
				query := dnsmessage.Message{Header: dnsmessage.Header{RecursionDesired: true}, Questions: []dnsmessage.Question{question}}
				packet, err := query.Pack()
				if err != nil {
					return nil, err
				}
				req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+endpoint+"/dns-query", bytes.NewReader(packet))
				if err != nil {
					return nil, err
				}
				req.Header.Set("Content-Type", "application/dns-message")
				res, err := client.Do(req)
				if err != nil {
					return nil, err
				}
				wire, readErr := io.ReadAll(io.LimitReader(res.Body, 65536))
				res.Body.Close()
				if readErr != nil || len(wire) > 65535 || res.StatusCode != http.StatusOK || res.Header.Get("Content-Type") != "application/dns-message" {
					return nil, fmt.Errorf("exit DNS returned an invalid response")
				}
				var response dnsmessage.Message
				if err := response.Unpack(wire); err != nil || !response.Response || response.Truncated || response.RCode != dnsmessage.RCodeSuccess || response.ID != query.ID || len(response.Questions) != 1 || response.Questions[0] != question {
					return nil, fmt.Errorf("exit DNS query failed")
				}
				for _, answer := range response.Answers {
					switch body := answer.Body.(type) {
					case *dnsmessage.AResource:
						addresses = append(addresses, netip.AddrFrom4(body.A))
					case *dnsmessage.AAAAResource:
						addresses = append(addresses, netip.AddrFrom16(body.AAAA).Unmap())
					}
				}
			}
			if len(addresses) == 0 {
				return nil, fmt.Errorf("exit DNS returned no addresses")
			}
			return addresses, nil
		}
		if peer.IsWireGuardOnly() {
			var resolvers []*dnstype.Resolver
			for _, resolver := range peer.ExitNodeDNSResolvers().All() {
				resolvers = append(resolvers, resolver.AsStruct())
			}
			if len(resolvers) > 0 {
				// The selected exit's explicit DNS addresses may be private; this narrow
				// exception still dials only through that session's netstack.
				dnsMap := &netmap.NetworkMap{DNS: tailcfg.DNSConfig{Routes: map[string][]*dnstype.Resolver{host: resolvers}}}
				addresses, _, err := resolveRestrictedDNS(ctx, network, host, dnsMap, "", dial)
				return addresses, err
			}
		}
		break
	}
	return nil, fmt.Errorf("selected exit has no supported DNS endpoint")
}

func exitProxyDNSEndpoint(nm *netmap.NetworkMap, peer tailcfg.NodeView) string {
	if !peer.Hostinfo().Valid() {
		return ""
	}
	canProxy := peer.Cap() >= 26
	for _, service := range peer.Hostinfo().Services().All() {
		if service.Proto == tailcfg.PeerAPIDNS && service.Port > 0 {
			canProxy = true
		}
	}
	if !canProxy {
		return ""
	}
	for _, is4 := range []bool{true, false} {
		haveFamily := false
		for _, address := range nm.GetAddresses().All() {
			if address.IsSingleIP() && address.Addr().Is4() == is4 {
				haveFamily = true
			}
		}
		if !haveFamily {
			continue
		}
		for _, service := range peer.Hostinfo().Services().All() {
			if service.Port == 0 || (is4 && service.Proto != tailcfg.PeerAPI4) || (!is4 && service.Proto != tailcfg.PeerAPI6) {
				continue
			}
			for _, address := range peer.Addresses().All() {
				if address.IsSingleIP() && address.Addr().Is4() == is4 && safeProxyIP(address.Addr()) {
					return netip.AddrPortFrom(address.Addr(), service.Port).String()
				}
			}
		}
	}
	return ""
}

func dialProxyDNSNetstack(ctx context.Context, ts *tsnet.Server, network, address string) (net.Conn, error) {
	target, err := netip.ParseAddrPort(address)
	if err != nil || target.Port() == 0 || !safeProxyIP(target.Addr()) {
		return nil, errProxyDestinationDenied
	}
	dialer := ts.Sys().Dialer.Get()
	switch network {
	case "tcp", "tcp4", "tcp6":
		if dialer.NetstackDialTCP != nil {
			return dialer.NetstackDialTCP(ctx, target)
		}
	case "udp", "udp4", "udp6":
		if dialer.NetstackDialUDP != nil {
			return dialer.NetstackDialUDP(ctx, target)
		}
	}
	return nil, errProxyDestinationDenied
}
