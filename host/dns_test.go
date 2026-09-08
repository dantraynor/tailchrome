package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/netip"
	"reflect"
	"strings"
	"sync"
	"testing"

	"golang.org/x/net/dns/dnsmessage"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/types/dnstype"
	"tailscale.com/types/netmap"
)

func TestDNSRouteDomains(t *testing.T) {
	nm := &netmap.NetworkMap{DNS: tailcfg.DNSConfig{Routes: map[string][]*dnstype.Resolver{
		"Internal.Example.": nil, "internal.example": nil, "other.example": nil,
		".": nil, "*.example": nil, "https://bad.example": nil, "127.0.0.1": nil,
		"bad..example": nil, "-bad.example": nil, "bad.example\n": nil,
	}}}
	if got, want := dnsRouteDomains(nm, ""), []string{"internal.example", "other.example"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("domains = %v, want %v", got, want)
	}
}

// dnsTestDial serves real DNS wire responses over a connection supplied to the
// Go resolver. No machine DNS settings or external nameserver are involved.
func dnsTestDial(t *testing.T, answer func(server, name string, queryType dnsmessage.Type) (netip.Addr, error)) func(context.Context, string, string) (net.Conn, error) {
	t.Helper()
	return func(ctx context.Context, network, server string) (net.Conn, error) {
		client, upstream := net.Pipe()
		go func() {
			defer upstream.Close()
			var size uint16
			if err := binary.Read(upstream, binary.BigEndian, &size); err != nil {
				return
			}
			packet := make([]byte, size)
			if _, err := io.ReadFull(upstream, packet); err != nil {
				return
			}
			var query dnsmessage.Message
			if err := query.Unpack(packet); err != nil || len(query.Questions) != 1 {
				t.Errorf("invalid query: %v", err)
				return
			}
			question := query.Questions[0]
			address, err := answer(server, question.Name.String(), question.Type)
			if err != nil {
				return
			}
			response := dnsmessage.Message{
				Header:    dnsmessage.Header{ID: query.ID, Response: true, RecursionAvailable: true},
				Questions: query.Questions,
			}
			if address.IsValid() {
				resource := dnsmessage.Resource{Header: dnsmessage.ResourceHeader{Name: question.Name, Type: question.Type, Class: dnsmessage.ClassINET, TTL: 60}}
				if question.Type == dnsmessage.TypeA && address.Is4() {
					resource.Body = &dnsmessage.AResource{A: address.As4()}
				} else if question.Type == dnsmessage.TypeAAAA && address.Is6() {
					resource.Body = &dnsmessage.AAAAResource{AAAA: address.As16()}
				}
				if resource.Body != nil {
					response.Answers = []dnsmessage.Resource{resource}
				}
			}
			packet, err = response.Pack()
			if err != nil {
				t.Errorf("pack response: %v", err)
				return
			}
			_ = binary.Write(upstream, binary.BigEndian, uint16(len(packet)))
			_, _ = upstream.Write(packet)
		}()
		return client, nil
	}
}

func TestRestrictedDNSUsesLongestSuffixAndLiteralNameserver(t *testing.T) {
	nm := &netmap.NetworkMap{DNS: tailcfg.DNSConfig{Routes: map[string][]*dnstype.Resolver{
		"example":           {{Addr: "100.64.0.53"}},
		"internal.example.": {{Addr: "10.0.0.53:5353"}},
	}}}
	var mu sync.Mutex
	var requests []string
	dial := dnsTestDial(t, func(server, name string, queryType dnsmessage.Type) (netip.Addr, error) {
		mu.Lock()
		requests = append(requests, server+" "+name)
		mu.Unlock()
		return netip.MustParseAddr("10.0.0.80"), nil
	})
	addresses, matched, err := resolveRestrictedDNS(context.Background(), "tcp4", "Wiki.Internal.Example", nm, "", dial)
	if err != nil || !matched || !reflect.DeepEqual(addresses, []netip.Addr{netip.MustParseAddr("10.0.0.80")}) {
		t.Fatalf("result = %v, %v, %v", addresses, matched, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(requests) == 0 {
		t.Fatal("no DNS requests")
	}
	for _, request := range requests {
		if request != "10.0.0.53:5353 wiki.internal.example." {
			t.Fatalf("unexpected DNS request %q", request)
		}
	}
}

func TestRestrictedDNSIPv6AndAlternateNameserver(t *testing.T) {
	nm := &netmap.NetworkMap{DNS: tailcfg.DNSConfig{Routes: map[string][]*dnstype.Resolver{
		"internal.example": {{Addr: "100.64.0.53"}, {Addr: "[fd7a:115c:a1e0::53]:5353"}},
	}}}
	dial := dnsTestDial(t, func(server, name string, queryType dnsmessage.Type) (netip.Addr, error) {
		if server == "100.64.0.53:53" {
			return netip.Addr{}, fmt.Errorf("nameserver unavailable")
		}
		if server != "[fd7a:115c:a1e0::53]:5353" {
			t.Errorf("unexpected nameserver %s", server)
		}
		return netip.MustParseAddr("fd7a:115c:a1e0::80"), nil
	})
	addresses, matched, err := resolveRestrictedDNS(context.Background(), "tcp6", "wiki.internal.example", nm, "", dial)
	if err != nil || !matched || len(addresses) != 1 || addresses[0].String() != "fd7a:115c:a1e0::80" {
		t.Fatalf("result = %v, %v, %v", addresses, matched, err)
	}
}

func TestRestrictedDNSDoesNotFallBackOutsideMatchedRoute(t *testing.T) {
	for _, server := range []string{"127.0.0.1", "169.254.169.254", "::", "224.0.0.1", "https://dns.example/query", "10.0.0.1:0"} {
		t.Run(server, func(t *testing.T) {
			nm := &netmap.NetworkMap{DNS: tailcfg.DNSConfig{Routes: map[string][]*dnstype.Resolver{
				"example":          {{Addr: "100.64.0.53"}},
				"internal.example": {{Addr: server}},
			}}}
			_, matched, err := resolveRestrictedDNS(context.Background(), "tcp", "wiki.internal.example", nm, "", func(context.Context, string, string) (net.Conn, error) {
				t.Error("invalid nameserver or broader DNS route was used")
				return nil, fmt.Errorf("unexpected dial")
			})
			if !matched || err == nil {
				t.Fatalf("matched = %v, err = %v", matched, err)
			}
		})
	}
}

func TestRestrictedDNSRejectsLocalAnswer(t *testing.T) {
	nm := &netmap.NetworkMap{DNS: tailcfg.DNSConfig{Routes: map[string][]*dnstype.Resolver{
		"internal.example": {{Addr: "100.64.0.53"}},
	}}}
	dial := dnsTestDial(t, func(string, string, dnsmessage.Type) (netip.Addr, error) {
		return netip.MustParseAddr("127.0.0.1"), nil
	})
	_, matched, err := resolveRestrictedDNS(context.Background(), "tcp4", "wiki.internal.example", nm, "", dial)
	if !matched || err == nil {
		t.Fatalf("matched = %v, err = %v", matched, err)
	}
}

func TestRestrictedDNSLeavesUnmatchedAndLocalRecordsAlone(t *testing.T) {
	nm := &netmap.NetworkMap{DNS: tailcfg.DNSConfig{Routes: map[string][]*dnstype.Resolver{
		"internal.example":       {{Addr: "100.64.0.53"}},
		"local.internal.example": nil,
	}}}
	for _, name := range []string{"notinternal.example", "example.com", "127.0.0.1", "x.local.internal.example", "bad..internal.example"} {
		_, matched, err := resolveRestrictedDNS(context.Background(), "tcp", name, nm, "", nil)
		if matched || err != nil {
			t.Fatalf("name %q: matched = %v, err = %v", name, matched, err)
		}
	}
}

func TestStatusDNSRoutesFollowNetworkMapAndDNSPreference(t *testing.T) {
	h := newHost(nil, nil)
	h.lastNetMap = &netmap.NetworkMap{DNS: tailcfg.DNSConfig{Routes: map[string][]*dnstype.Resolver{"internal.example": nil}}}
	st := &ipnstate.Status{BackendState: "Running"}
	if h.buildStatusUpdate(st).DNSRoutes != nil {
		t.Fatal("DNS routes must wait for current DNS preferences")
	}
	h.lastPrefs = &PrefsView{CorpDNS: true}
	if got := h.buildStatusUpdate(st).DNSRoutes; got == nil || !reflect.DeepEqual(*got, []string{"internal.example"}) {
		t.Fatalf("DNS routes = %v", got)
	}
	for _, disabled := range []bool{false, true} {
		h.lastPrefs.CorpDNS = !disabled
		h.lastNetMap = &netmap.NetworkMap{}
		encoded, err := json.Marshal(h.buildStatusUpdate(st))
		if err != nil || !strings.Contains(string(encoded), `"dnsRoutes":[]`) {
			t.Fatalf("confirmed empty DNS must clear browser routes: %s, %v", encoded, err)
		}
	}
	h.clearCachedStatus(&ipn.Prefs{CorpDNS: true})
	if h.lastNetMap != nil || h.buildStatusUpdate(st).DNSRoutes != nil {
		t.Fatal("unavailable network map must preserve browser routes")
	}
	encoded, err := json.Marshal(h.buildStatusUpdate(st))
	if err != nil || strings.Contains(string(encoded), `"dnsRoutes"`) {
		t.Fatalf("unavailable map must omit DNS routes: %s, %v", encoded, err)
	}
	h.lastPrefs.CorpDNS = false
	encoded, err = json.Marshal(h.buildStatusUpdate(st))
	if err != nil || !strings.Contains(string(encoded), `"dnsRoutes":[]`) {
		t.Fatalf("explicitly disabled DNS must clear routes even without a map: %s, %v", encoded, err)
	}
}

func restrictedExitDNSMap() *netmap.NetworkMap {
	return &netmap.NetworkMap{
		Peers: []tailcfg.NodeView{(&tailcfg.Node{StableID: "exit", Cap: 26}).View()},
		DNS: tailcfg.DNSConfig{Routes: map[string][]*dnstype.Resolver{
			"internal.example": {{Addr: "10.0.0.51"}, {Addr: "10.0.0.52", UseWithExitNode: true}},
			"ordinary.example": {{Addr: "10.0.0.53"}},
			"local.example":    nil,
		}},
	}
}

func TestExitDNSRouteEligibilityMatchesPeerCapabilities(t *testing.T) {
	for _, tt := range []struct {
		name   string
		peer   *tailcfg.Node
		exit   string
		filter bool
	}{
		{name: "no exit", peer: &tailcfg.Node{StableID: "exit", Cap: 26}},
		{name: "modern exit", peer: &tailcfg.Node{StableID: "exit", Cap: 26}, exit: "exit", filter: true},
		{name: "legacy advertised DNS", peer: &tailcfg.Node{StableID: "exit", Hostinfo: (&tailcfg.Hostinfo{Services: []tailcfg.Service{{Proto: tailcfg.PeerAPIDNS, Port: 1}}}).View()}, exit: "exit", filter: true},
		{name: "older exit without DNS", peer: &tailcfg.Node{StableID: "exit", Cap: 25}, exit: "exit"},
		{name: "WireGuard exit", peer: &tailcfg.Node{StableID: "exit", IsWireGuardOnly: true}, exit: "exit"},
		{name: "missing exit", peer: &tailcfg.Node{StableID: "other", Cap: 26}, exit: "exit"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			nm := restrictedExitDNSMap()
			nm.Peers = []tailcfg.NodeView{tt.peer.View()}
			want := []string{"internal.example", "local.example", "ordinary.example"}
			if tt.filter {
				want = []string{"internal.example", "local.example"}
			}
			if got := dnsRouteDomains(nm, tt.exit); !reflect.DeepEqual(got, want) {
				t.Fatalf("domains = %v, want %v", got, want)
			}
			// Filtering must not alter the authoritative network map.
			if len(nm.DNS.Routes["internal.example"]) != 2 || len(nm.DNS.Routes["ordinary.example"]) != 1 {
				t.Fatal("network map routes changed")
			}
		})
	}
}

func TestRestrictedDNSFiltersMixedResolversBeforeLookup(t *testing.T) {
	for _, exitNodeID := range []string{"", "exit"} {
		t.Run("exit="+exitNodeID, func(t *testing.T) {
			wantServer := "10.0.0.51:53"
			if exitNodeID != "" {
				wantServer = "10.0.0.52:53"
			}
			dial := dnsTestDial(t, func(server, name string, queryType dnsmessage.Type) (netip.Addr, error) {
				if server != wantServer {
					t.Errorf("DNS server = %q, want %q", server, wantServer)
				}
				return netip.MustParseAddr("10.0.0.80"), nil
			})
			addresses, matched, err := resolveRestrictedDNS(context.Background(), "tcp4", "wiki.internal.example", restrictedExitDNSMap(), exitNodeID, dial)
			if err != nil || !matched || len(addresses) != 1 {
				t.Fatalf("result = %v, %v, %v", addresses, matched, err)
			}
		})
	}
}

func TestIneligibleRestrictedDNSDefersToExitDNS(t *testing.T) {
	for _, host := range []string{"ordinary.example", "wiki.ordinary.example"} {
		_, matched, err := resolveRestrictedDNS(context.Background(), "tcp4", host, restrictedExitDNSMap(), "exit", func(context.Context, string, string) (net.Conn, error) {
			t.Error("ineligible nameserver was used instead of exit DNS")
			return nil, fmt.Errorf("unexpected DNS dial")
		})
		if matched || err != nil {
			t.Fatalf("host %s: matched = %v, err = %v", host, matched, err)
		}
	}
}

func TestExitDNSFiltersRoutesBeforeLongestSuffixSelection(t *testing.T) {
	nm := restrictedExitDNSMap()
	nm.DNS.Routes = map[string][]*dnstype.Resolver{
		"example":                {{Addr: "10.0.0.52", UseWithExitNode: true}},
		"internal.example":       {{Addr: "10.0.0.51"}},
		"local.internal.example": nil,
	}
	dial := dnsTestDial(t, func(server, name string, queryType dnsmessage.Type) (netip.Addr, error) {
		if server != "10.0.0.52:53" {
			t.Errorf("DNS server = %q, want eligible parent route", server)
		}
		return netip.MustParseAddr("10.0.0.80"), nil
	})
	_, matched, err := resolveRestrictedDNS(context.Background(), "tcp4", "wiki.internal.example", nm, "exit", dial)
	if !matched || err != nil {
		t.Fatalf("matched = %v, err = %v", matched, err)
	}
	_, matched, err = resolveRestrictedDNS(context.Background(), "tcp4", "wiki.local.internal.example", nm, "exit", nil)
	if matched || err != nil {
		t.Fatal("empty local-record route did not suppress broader resolver")
	}
}

func TestExitDNSDoesNotFallBackToIneligiblePlainResolver(t *testing.T) {
	nm := restrictedExitDNSMap()
	nm.DNS.Routes["internal.example"] = []*dnstype.Resolver{
		{Addr: "10.0.0.51"},
		{Addr: "https://dns.example/query", UseWithExitNode: true},
	}
	_, matched, err := resolveRestrictedDNS(context.Background(), "tcp4", "wiki.internal.example", nm, "exit", func(context.Context, string, string) (net.Conn, error) {
		t.Error("ineligible fallback resolver was used")
		return nil, fmt.Errorf("unexpected DNS dial")
	})
	if !matched || err == nil {
		t.Fatalf("matched = %v, err = %v", matched, err)
	}
}

func TestStatusAdvertisesOnlyEligibleExitDNSRoutes(t *testing.T) {
	h := newHost(nil, nil)
	h.lastNetMap = restrictedExitDNSMap()
	h.lastPrefs = &PrefsView{ExitNodeID: "exit", CorpDNS: true}
	want := []string{"internal.example", "local.example"}
	if got := h.buildStatusUpdate(&ipnstate.Status{}).DNSRoutes; got == nil || !reflect.DeepEqual(*got, want) {
		t.Fatalf("domains from selected exit prefs = %v, want %v", got, want)
	}
	h.lastPrefs.ExitNodeID = ""
	st := &ipnstate.Status{ExitNodeStatus: &ipnstate.ExitNodeStatus{ID: "exit"}}
	if got := h.buildStatusUpdate(st).DNSRoutes; got == nil || len(*got) != 3 {
		t.Fatalf("cached prefs should override stale exit status: %v", got)
	}
}
