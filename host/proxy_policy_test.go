package main

import (
	"net/netip"
	"tailscale.com/ipn"
	"tailscale.com/tailcfg"
	"tailscale.com/types/netmap"
	"testing"
)

func proxyPolicyMap() *netmap.NetworkMap {
	node := &tailcfg.Node{StableID: "exit", Name: "router.example.ts.net.", Addresses: []netip.Prefix{netip.MustParsePrefix("100.64.0.2/32")},
		AllowedIPs: []netip.Prefix{netip.MustParsePrefix("0.0.0.0/0"), netip.MustParsePrefix("::/0"), netip.MustParsePrefix("10.20.0.0/16")}, PrimaryRoutes: []netip.Prefix{netip.MustParsePrefix("10.20.0.0/16")}}
	return &netmap.NetworkMap{Peers: []tailcfg.NodeView{node.View()}}
}

func TestProxyDestinationPolicy(t *testing.T) {
	nm := proxyPolicyMap()
	lan := []netip.Prefix{netip.MustParsePrefix("192.168.1.0/24")}
	for _, tc := range []struct {
		name, ip, exit                       string
		routes, lan, running, allowed, local bool
	}{
		{name: "tailnet", ip: "100.64.0.2", running: true, allowed: true},
		{name: "tailnet IPv6", ip: "fd7a:115c:a1e0::1", running: true, allowed: true},
		{name: "approved route", ip: "10.20.1.1", routes: true, running: true, allowed: true},
		{name: "routes disabled", ip: "10.20.1.1", running: true},
		{name: "unapproved private", ip: "10.21.1.1", routes: true, running: true},
		{name: "internet no exit", ip: "8.8.8.8", running: true},
		{name: "internet exit", ip: "8.8.8.8", exit: "exit", running: true, allowed: true},
		{name: "missing selected exit", ip: "8.8.8.8", exit: "gone", running: true},
		{name: "LAN disabled", ip: "192.168.1.10", exit: "exit", running: true},
		{name: "attached LAN", ip: "192.168.1.10", exit: "exit", lan: true, running: true, allowed: true, local: true},
		{name: "unattached LAN", ip: "192.168.2.10", exit: "exit", lan: true, running: true},
		{name: "loopback", ip: "127.0.0.1", exit: "exit", lan: true, running: true},
		{name: "mapped loopback", ip: "::ffff:127.0.0.1", exit: "exit", running: true},
		{name: "metadata", ip: "169.254.169.254", exit: "exit", running: true},
		{name: "multicast", ip: "224.0.0.1", exit: "exit", running: true},
		{name: "IPv6 linklocal", ip: "fe80::1", exit: "exit", running: true},
		{name: "stopped", ip: "100.64.0.2"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			prefs := &ipn.Prefs{WantRunning: tc.running, RouteAll: tc.routes, ExitNodeID: tailcfg.StableNodeID(tc.exit), ExitNodeAllowLANAccess: tc.lan}
			got, local := proxyIPAllowed(nm, prefs, netip.MustParseAddr(tc.ip), lan)
			if got != tc.allowed || local != tc.local {
				t.Fatalf("allowed/local = %v/%v, want %v/%v", got, local, tc.allowed, tc.local)
			}
		})
	}
}

func TestProxyPolicyRejectsUnapprovedAndUnsafeRoutes(t *testing.T) {
	for _, cidr := range []string{"0.0.0.0/0", "0.0.0.0/1", "127.0.0.0/8", "169.254.0.0/16", "::/0", "fe80::/10"} {
		if safeProxyRoute(netip.MustParsePrefix(cidr)) {
			t.Errorf("accepted unsafe route %s", cidr)
		}
	}
	nm := proxyPolicyMap()
	peer := nm.Peers[0].AsStruct()
	peer.AllowedIPs = []netip.Prefix{netip.MustParsePrefix("0.0.0.0/0")}
	nm.Peers = []tailcfg.NodeView{peer.View()}
	if approvedProxySubnet(nm, netip.MustParseAddr("10.20.1.1")) {
		t.Fatal("unapproved primary route accepted through default route")
	}
}

func TestProxyMagicDNSUsesAuthoritativeAddresses(t *testing.T) {
	nm := proxyPolicyMap()
	for _, name := range []string{"router", "router.example.ts.net", "ROUTER.EXAMPLE.TS.NET."} {
		got := proxyMagicDNSAddresses(nm, name)
		if len(got) != 1 || got[0] != netip.MustParseAddr("100.64.0.2") {
			t.Fatalf("lookup %s = %v", name, got)
		}
	}
	if len(proxyMagicDNSAddresses(nm, "router.example.ts.net.evil")) != 0 {
		t.Fatal("suffix spoof accepted")
	}
}

func TestProxyExtraDNSRecordsUseExactNamesAndValidatedDestinations(t *testing.T) {
	nm := proxyPolicyMap()
	nm.DNS.ExtraRecords = []tailcfg.DNSRecord{
		{Name: "Wiki.Internal.Example.", Value: "100.64.0.3"},
		{Name: "wiki.internal.example", Type: "A", Value: "10.20.1.1"},
		{Name: "wiki.internal.example", Type: "AAAA", Value: "fd7a:115c:a1e0::3"},
		{Name: "wiki.internal.example", Type: "TXT", Value: "100.64.0.9"},
		{Name: "wiki.internal.example", Type: "A", Value: "not-an-address"},
		{Name: "local.internal.example", Value: "::ffff:127.0.0.1"},
	}
	got := proxyMagicDNSAddresses(nm, "WIKI.INTERNAL.EXAMPLE.")
	if len(got) != 3 {
		t.Fatalf("addresses %v", got)
	}
	if len(proxyMagicDNSAddresses(nm, "wiki")) != 0 || len(proxyMagicDNSAddresses(nm, "wiki.internal.example.attacker")) != 0 {
		t.Fatal("inexact extra record matched")
	}
	local := proxyMagicDNSAddresses(nm, "local.internal.example")
	if len(local) != 1 {
		t.Fatal("missing local record")
	}
	if allowed, _ := proxyIPAllowed(nm, &ipn.Prefs{WantRunning: true, RouteAll: true}, local[0], nil); allowed {
		t.Fatal("unsafe extra record bypassed destination validation")
	}
}
