package main

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"reflect"
	"testing"

	"golang.org/x/net/dns/dnsmessage"
	"tailscale.com/tailcfg"
	"tailscale.com/types/dnstype"
	"tailscale.com/types/netmap"
)

func exitDNSMap() *netmap.NetworkMap {
	self := (&tailcfg.Node{Addresses: []netip.Prefix{netip.MustParsePrefix("100.64.0.1/32")}}).View()
	peer := (&tailcfg.Node{StableID: "exit", Cap: 26, Addresses: []netip.Prefix{netip.MustParsePrefix("100.64.0.2/32")}, Hostinfo: (&tailcfg.Hostinfo{Services: []tailcfg.Service{{Proto: tailcfg.PeerAPI4, Port: 1234}}}).View()}).View()
	return &netmap.NetworkMap{SelfNode: self, Peers: []tailcfg.NodeView{peer}}
}

func exitDNSResponse(t *testing.T, packet []byte) []byte {
	t.Helper()
	var query dnsmessage.Message
	if err := query.Unpack(packet); err != nil || len(query.Questions) != 1 {
		t.Errorf("invalid query: %v", err)
		return nil
	}
	q := query.Questions[0]
	response := dnsmessage.Message{Header: dnsmessage.Header{ID: query.ID, Response: true}, Questions: query.Questions}
	if q.Type == dnsmessage.TypeA {
		response.Answers = []dnsmessage.Resource{{Header: dnsmessage.ResourceHeader{Name: q.Name, Type: q.Type, Class: dnsmessage.ClassINET}, Body: &dnsmessage.AResource{A: [4]byte{8, 8, 8, 8}}}}
	}
	packet, err := response.Pack()
	if err != nil {
		t.Errorf("pack response: %v", err)
	}
	return packet
}

func TestExitDNSPinsSelectedPeerEndpoint(t *testing.T) {
	for _, mode := range []string{"success", "redirect", "wrong content", "wrong question"} {
		t.Run(mode, func(t *testing.T) {
			count := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				count++
				if r.Host != "100.64.0.2:1234" || r.Method != http.MethodPost || r.URL.Path != "/dns-query" || r.Header.Get("Content-Type") != "application/dns-message" {
					t.Errorf("unexpected request: %s %s %s", r.Method, r.Host, r.URL)
				}
				if mode == "redirect" {
					http.Redirect(w, r, "http://127.0.0.1/private", http.StatusFound)
					return
				}
				packet, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error(err)
					return
				}
				wire := exitDNSResponse(t, packet)
				w.Header().Set("Content-Type", "application/dns-message")
				if mode == "wrong content" {
					w.Header().Set("Content-Type", "text/plain")
				}
				if mode == "wrong question" {
					var response dnsmessage.Message
					_ = response.Unpack(wire)
					response.Questions = nil
					wire, _ = response.Pack()
				}
				_, _ = w.Write(wire)
			}))
			defer server.Close()
			dial := func(ctx context.Context, network, address string) (net.Conn, error) {
				if address != "100.64.0.2:1234" {
					t.Errorf("unselected endpoint %s", address)
				}
				var d net.Dialer
				return d.DialContext(ctx, network, server.Listener.Addr().String())
			}
			addresses, err := queryExitProxyDNS(context.Background(), exitDNSMap(), "exit", "tcp", "www.example.test", dial)
			if mode == "success" {
				if err != nil || !reflect.DeepEqual(addresses, []netip.Addr{netip.MustParseAddr("8.8.8.8")}) || count != 2 {
					t.Fatalf("addresses %v, error %v, requests %d", addresses, err, count)
				}
			} else if err == nil || count != 1 {
				t.Fatalf("invalid reply accepted or redirect followed: %v, %d requests", err, count)
			}
		})
	}
}

func TestExitDNSDoesNotFallBackWhenSelectedPeerUnavailable(t *testing.T) {
	for _, id := range []string{"", "missing"} {
		_, err := queryExitProxyDNS(context.Background(), exitDNSMap(), id, "tcp", "www.example.test", func(context.Context, string, string) (net.Conn, error) { t.Fatal("unexpected dial"); return nil, nil })
		if err == nil {
			t.Fatal("missing exit accepted")
		}
	}
	nm := exitDNSMap()
	peer := nm.Peers[0].AsStruct()
	peer.Cap = 0
	nm.Peers[0] = peer.View()
	if endpoint := exitProxyDNSEndpoint(nm, nm.Peers[0]); endpoint != "" {
		t.Fatalf("unsupported exit endpoint %s", endpoint)
	}
	peer.Hostinfo = (&tailcfg.Hostinfo{Services: []tailcfg.Service{{Proto: tailcfg.PeerAPI4, Port: 1234}, {Proto: tailcfg.PeerAPIDNS, Port: 1}}}).View()
	nm.Peers[0] = peer.View()
	if endpoint := exitProxyDNSEndpoint(nm, nm.Peers[0]); endpoint != "100.64.0.2:1234" {
		t.Fatalf("legacy exit endpoint %s", endpoint)
	}
}

func TestWireGuardExitDNSUsesOnlyAdvertisedLiteralResolver(t *testing.T) {
	nm := exitDNSMap()
	peer := nm.Peers[0].AsStruct()
	peer.Cap = 0
	peer.IsWireGuardOnly = true
	peer.ExitNodeDNSResolvers = []*dnstype.Resolver{{Addr: "10.64.0.1"}}
	nm.Peers[0] = peer.View()
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "10.64.0.1:53" {
			t.Errorf("unexpected DNS address %s", address)
		}
		client, upstream := net.Pipe()
		go func() {
			defer upstream.Close()
			var size uint16
			if binary.Read(upstream, binary.BigEndian, &size) != nil {
				return
			}
			packet := make([]byte, size)
			if _, err := io.ReadFull(upstream, packet); err != nil {
				return
			}
			wire := exitDNSResponse(t, packet)
			_ = binary.Write(upstream, binary.BigEndian, uint16(len(wire)))
			_, _ = upstream.Write(wire)
		}()
		return client, nil
	}
	addresses, err := queryExitProxyDNS(context.Background(), nm, "exit", "tcp4", "www.example.test", dial)
	if err != nil || !reflect.DeepEqual(addresses, []netip.Addr{netip.MustParseAddr("8.8.8.8")}) {
		t.Fatalf("addresses %v, err %v", addresses, err)
	}
	peer.ExitNodeDNSResolvers = []*dnstype.Resolver{{Addr: "127.0.0.1"}}
	nm.Peers[0] = peer.View()
	_, err = queryExitProxyDNS(context.Background(), nm, "exit", "tcp4", "www.example.test", func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("unsafe resolver dialed")
		return nil, nil
	})
	if err == nil {
		t.Fatal("unsafe resolver accepted")
	}
}
