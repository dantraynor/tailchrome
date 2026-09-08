package main

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/http/httptest"
	"net/netip"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"tailscale.com/derp/derpserver"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/ipn/store/mem"
	"tailscale.com/net/netns"
	"tailscale.com/net/stun/stuntest"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/dnstype"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
	"tailscale.com/types/nettype"
)

// Exercise the actual LocalAPI resolver and userspace subnet routing together.
// Neither the restricted name nor its documentation-range IP can resolve or
// connect through the machine's ordinary DNS and networking.
func TestSplitDNSThroughSubnetRouter(t *testing.T) {
	if testing.Short() {
		t.Skip("starts two embedded tailnet nodes")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })
	config := &tailcfg.DNSConfig{
		Proxied: true,
		Routes: map[string][]*dnstype.Resolver{
			"internal.example.com": {{Addr: "192.0.2.53"}},
		},
	}
	control := &testcontrol.Server{
		DERPMap:        splitDNSTestDERP(t),
		DNSConfig:      config,
		MagicDNSDomain: "test.ts.net",
		Logf:           t.Logf,
	}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	t.Cleanup(control.HTTPTestServer.Close)
	startNode := func(name string) (*tsnet.Server, *ipnstate.Status) {
		t.Helper()
		node := &tsnet.Server{
			Dir: t.TempDir(), Hostname: name, ControlURL: control.HTTPTestServer.URL,
			Store: new(mem.Store), Ephemeral: true, Logf: t.Logf,
		}
		t.Cleanup(func() { node.Close() })
		status, err := node.Up(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return node, status
	}
	router, routerStatus := startNode("split-dns-router")
	var sawA, sawAAAA atomic.Bool
	router.RegisterFallbackTCPHandler(func(_, destination netip.AddrPort) (func(net.Conn), bool) {
		switch destination.String() {
		case "192.0.2.53:53":
			return func(conn net.Conn) {
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(5 * time.Second))
				var length uint16
				if err := binary.Read(conn, binary.BigEndian, &length); err != nil {
					t.Error(err)
					return
				}
				packet := make([]byte, length)
				if _, err := io.ReadFull(conn, packet); err != nil {
					t.Error(err)
					return
				}
				var message dnsmessage.Message
				if err := message.Unpack(packet); err != nil || len(message.Questions) != 1 {
					t.Errorf("invalid DNS query: %v", err)
					return
				}
				question := message.Questions[0]
				message.Response = true
				message.RecursionAvailable = true
				if question.Name.String() != "service.internal.example.com." {
					t.Errorf("unexpected query for %s", question.Name)
					return
				}
				switch question.Type {
				case dnsmessage.TypeA:
					sawA.Store(true)
					message.Answers = []dnsmessage.Resource{testDNSAddress(question.Name.String(), "192.0.2.80")}
				case dnsmessage.TypeAAAA:
					sawAAAA.Store(true)
				default:
					t.Errorf("unexpected query type: %v", question.Type)
					return
				}
				response, err := message.Pack()
				if err != nil {
					t.Error(err)
					return
				}
				binary.Write(conn, binary.BigEndian, uint16(len(response)))
				conn.Write(response)
			}, true
		case "192.0.2.80:80":
			return func(conn net.Conn) {
				defer conn.Close()
				io.WriteString(conn, "split DNS reached the subnet service")
			}, true
		default:
			return nil, true
		}
	})
	routerClient, err := router.LocalClient()
	if err != nil {
		t.Fatal(err)
	}
	routes := []netip.Prefix{netip.MustParsePrefix("192.0.2.0/24")}
	if _, err := routerClient.EditPrefs(ctx, &ipn.MaskedPrefs{
		Prefs: ipn.Prefs{AdvertiseRoutes: routes}, AdvertiseRoutesSet: true,
	}); err != nil {
		t.Fatal(err)
	}
	control.SetSubnetRoutes(routerStatus.Self.PublicKey, routes)
	client, _ := startNode("split-dns-client")
	lc, err := client.LocalClient()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lc.EditPrefs(ctx, &ipn.MaskedPrefs{
		Prefs: ipn.Prefs{RouteAll: true, CorpDNS: true}, RouteAllSet: true, CorpDNSSet: true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := lc.Ping(ctx, routerStatus.TailscaleIPs[0], tailcfg.PingTSMP); err != nil {
		t.Fatal(err)
	}
	watcher, err := lc.WatchIPNBus(ctx, ipn.NotifyInitialNetMap)
	if err != nil {
		t.Fatal(err)
	}
	notification, err := watcher.Next()
	watcher.Close()
	if err != nil {
		t.Fatal(err)
	}
	if notification.NetMap == nil {
		t.Fatal("missing authoritative network map")
	}
	host := &Host{ts: client, lc: lc, lastNetMap: notification.NetMap, lastSplitDNSDomains: configuredSplitDNSDomains(config), lastPrefs: &PrefsView{CorpDNS: true}}
	conn, err := host.tsnetDialer(ctx, "tcp", "service.internal.example.com:80")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	payload, err := io.ReadAll(conn)
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != "split DNS reached the subnet service" {
		t.Fatalf("unexpected service response: %q", payload)
	}
	if !sawA.Load() || !sawAAAA.Load() {
		t.Errorf("subnet DNS queries: A=%v, AAAA=%v; want both", sawA.Load(), sawAAAA.Load())
	}
}

func splitDNSTestDERP(t *testing.T) *tailcfg.DERPMap {
	t.Helper()
	relay := derpserver.New(key.NewNode(), logger.Discard)
	server := httptest.NewTLSServer(derpserver.Handler(relay))
	stun, closeSTUN := stuntest.ServeWithPacketListener(t, nettype.Std{})
	t.Cleanup(func() {
		server.CloseClientConnections()
		server.Close()
		relay.Close()
		closeSTUN()
	})
	return &tailcfg.DERPMap{Regions: map[int]*tailcfg.DERPRegion{
		1: {
			RegionID: 1, RegionCode: "test", Nodes: []*tailcfg.DERPNode{{
				Name: "test", RegionID: 1, HostName: "127.0.0.1", IPv4: "127.0.0.1", IPv6: "none",
				DERPPort: server.Listener.Addr().(*net.TCPAddr).Port, STUNPort: stun.Port,
				STUNTestIP: "127.0.0.1", InsecureForTests: true,
			}},
		},
	}}
}
