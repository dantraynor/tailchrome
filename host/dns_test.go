package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/types/dnstype"
	"tailscale.com/types/netmap"
)

func testSplitDNSDomains() []string {
	return []string{"internal.example.com", "records.example.com"}
}

func testDNSResponse(t *testing.T, name, queryType string, rcode dnsmessage.RCode, answers ...dnsmessage.Resource) []byte {
	t.Helper()
	typ := dnsmessage.TypeA
	if queryType == "AAAA" {
		typ = dnsmessage.TypeAAAA
	}
	message := dnsmessage.Message{
		Header: dnsmessage.Header{Response: true, RCode: rcode},
		Questions: []dnsmessage.Question{{
			Name: dnsmessage.MustNewName(name), Type: typ, Class: dnsmessage.ClassINET,
		}},
		Answers: answers,
	}
	response, err := message.Pack()
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func testDNSAddress(name, address string) dnsmessage.Resource {
	ip := netip.MustParseAddr(address)
	resource := dnsmessage.Resource{Header: dnsmessage.ResourceHeader{
		Name: dnsmessage.MustNewName(name), Class: dnsmessage.ClassINET,
	}}
	if ip.Is4() {
		resource.Header.Type = dnsmessage.TypeA
		resource.Body = &dnsmessage.AResource{A: ip.As4()}
	} else {
		resource.Header.Type = dnsmessage.TypeAAAA
		resource.Body = &dnsmessage.AAAAResource{AAAA: ip.As16()}
	}
	return resource
}

func testDNSAlias(name, target string) dnsmessage.Resource {
	return dnsmessage.Resource{
		Header: dnsmessage.ResourceHeader{Name: dnsmessage.MustNewName(name), Type: dnsmessage.TypeCNAME, Class: dnsmessage.ClassINET},
		Body:   &dnsmessage.CNAMEResource{CNAME: dnsmessage.MustNewName(target)},
	}
}

func TestSplitDNSMatches(t *testing.T) {
	for _, tt := range []struct {
		host string
		want bool
	}{
		{"internal.example.com", true},
		{"service.internal.example.com", true},
		{"SERVICE.INTERNAL.EXAMPLE.COM.", true},
		{"records.example.com", true},
		{"public.example.com", false},
		{"notinternal.example.com", false},
		{"internal.example.com.public.example", false},
	} {
		t.Run(tt.host, func(t *testing.T) {
			if got := splitDNSMatches(tt.host, testSplitDNSDomains()); got != tt.want {
				t.Errorf("splitDNSMatches = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestDialWithSplitDNSPreservesUnmatchedAddresses(t *testing.T) {
	for _, address := range []string{
		"public.example.com:443", "peer.tailnet.ts.net:80", "192.168.1.10:443", "[fd7a:115c:a1e0::1]:80",
	} {
		t.Run(address, func(t *testing.T) {
			query := func(context.Context, string, string) ([]byte, error) {
				t.Error("unexpected restricted DNS query")
				return nil, errors.New("unexpected query")
			}
			dialErr := errors.New("dial result")
			_, err := dialWithSplitDNS(context.Background(), "tcp", address, testSplitDNSDomains(), query, func(_ context.Context, network, got string) (net.Conn, error) {
				if got != address || network != "tcp" {
					t.Errorf("dial(%q, %q), want tcp, %q", network, got, address)
				}
				return nil, dialErr
			})
			if !errors.Is(err, dialErr) {
				t.Errorf("err = %v, want dial result", err)
			}
		})
	}
}

func TestDialWithSplitDNSRetriesResolvedAddresses(t *testing.T) {
	name := "service.internal.example.com."
	query := func(_ context.Context, gotName, typ string) ([]byte, error) {
		if gotName != name {
			t.Errorf("query name = %q, want %q", gotName, name)
		}
		address := "192.168.1.10"
		if typ == "AAAA" {
			address = "fd00::10"
		}
		return testDNSResponse(t, gotName, typ, dnsmessage.RCodeSuccess, testDNSAddress(gotName, address)), nil
	}
	var mu sync.Mutex
	var dialed []string
	upstream, peer := net.Pipe()
	defer upstream.Close()
	defer peer.Close()
	conn, err := dialWithSplitDNS(context.Background(), "tcp", "SERVICE.INTERNAL.EXAMPLE.COM.:443", testSplitDNSDomains(), query, func(_ context.Context, _ string, address string) (net.Conn, error) {
		mu.Lock()
		dialed = append(dialed, address)
		mu.Unlock()
		if address == "192.168.1.10:443" {
			return upstream, nil
		}
		return nil, errors.New("IPv6 unavailable")
	})
	if err != nil || conn != upstream {
		t.Fatalf("dial = %v, %v, want successful IPv4 connection", conn, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if want := []string{"[fd00::10]:443", "192.168.1.10:443"}; !slices.Equal(dialed, want) {
		t.Errorf("dialed = %v, want %v", dialed, want)
	}
}

func TestDialWithSplitDNSNeverFallsBackAfterLookupFailure(t *testing.T) {
	for _, failure := range []string{"nxdomain", "servfail", "transport", "empty", "malformed"} {
		t.Run(failure, func(t *testing.T) {
			query := func(_ context.Context, name, typ string) ([]byte, error) {
				switch failure {
				case "transport":
					return nil, errors.New("nameserver unreachable")
				case "malformed":
					return []byte{1, 2, 3}, nil
				case "servfail":
					return testDNSResponse(t, name, typ, dnsmessage.RCodeServerFailure), nil
				case "empty":
					return testDNSResponse(t, name, typ, dnsmessage.RCodeSuccess), nil
				default:
					return testDNSResponse(t, name, typ, dnsmessage.RCodeNameError), nil
				}
			}
			_, err := dialWithSplitDNS(context.Background(), "tcp", "service.internal.example.com:443", testSplitDNSDomains(), query, func(context.Context, string, string) (net.Conn, error) {
				t.Error("failed restricted lookup fell back to dialing")
				return nil, nil
			})
			if err == nil {
				t.Fatal("expected restricted lookup error")
			}
		})
	}
}

func TestLookupSplitDNSCNAME(t *testing.T) {
	for _, tt := range []struct {
		name         string
		sameResponse bool
	}{
		{"complete answer", true},
		{"alias follow-up", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			const name = "service.internal.example.com."
			const target = "service.other.example."
			var queried []string
			ips, err := lookupSplitDNS(context.Background(), "tcp4", name, func(_ context.Context, got, typ string) ([]byte, error) {
				queried = append(queried, got)
				var answers []dnsmessage.Resource
				if got == name {
					answers = append(answers, testDNSAlias(name, target))
				}
				if tt.sameResponse || got == target {
					answers = append(answers, testDNSAddress(target, "192.168.1.20"))
				}
				return testDNSResponse(t, got, typ, dnsmessage.RCodeSuccess, answers...), nil
			})
			if err != nil || !slices.Equal(ips, []netip.Addr{netip.MustParseAddr("192.168.1.20")}) {
				t.Fatalf("lookup = %v, %v", ips, err)
			}
			want := []string{name}
			if !tt.sameResponse {
				want = append(want, target)
			}
			if !slices.Equal(queried, want) {
				t.Errorf("queried = %v, want %v", queried, want)
			}
		})
	}
}

func TestLookupSplitDNSRejectsCNAMELoops(t *testing.T) {
	_, err := lookupSplitDNS(context.Background(), "tcp4", "service.internal.example.com", func(_ context.Context, name, typ string) ([]byte, error) {
		return testDNSResponse(t, name, typ, dnsmessage.RCodeSuccess, testDNSAlias(name, name)), nil
	})
	if err == nil || !strings.Contains(err.Error(), "CNAME loop") {
		t.Fatalf("err = %v, want CNAME loop", err)
	}
}

func TestLookupSplitDNSIPv6Only(t *testing.T) {
	ips, err := lookupSplitDNS(context.Background(), "tcp6", "service.internal.example.com", func(_ context.Context, name, typ string) ([]byte, error) {
		if typ != "AAAA" {
			t.Errorf("queried %s, want AAAA only", typ)
		}
		return testDNSResponse(t, name, typ, dnsmessage.RCodeSuccess, testDNSAddress(name, "fd00::20")), nil
	})
	if err != nil || !slices.Equal(ips, []netip.Addr{netip.MustParseAddr("fd00::20")}) {
		t.Fatalf("lookup = %v, %v", ips, err)
	}
}

func TestLookupSplitDNSUsesSuccessfulAddressFamily(t *testing.T) {
	ips, err := lookupSplitDNS(context.Background(), "tcp", "service.internal.example.com", func(_ context.Context, name, typ string) ([]byte, error) {
		if typ == "AAAA" {
			return nil, errors.New("AAAA server failure")
		}
		return testDNSResponse(t, name, typ, dnsmessage.RCodeSuccess, testDNSAddress(name, "192.168.1.20")), nil
	})
	if err != nil || len(ips) != 1 || ips[0].String() != "192.168.1.20" {
		t.Fatalf("lookup = %v, %v", ips, err)
	}
}

func TestLookupSplitDNSCancellation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	finished := make(chan struct{}, 2)
	_, err := lookupSplitDNS(ctx, "tcp", "service.internal.example.com", func(ctx context.Context, _, _ string) ([]byte, error) {
		if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > splitDNSLookupTimeout {
			t.Error("DNS query context has no bounded deadline")
		}
		<-ctx.Done()
		finished <- struct{}{}
		return nil, ctx.Err()
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lookup error = %v, want deadline exceeded", err)
	}
	for range 2 {
		select {
		case <-finished:
		case <-time.After(time.Second):
			t.Fatal("canceled DNS query did not stop")
		}
	}
}

func TestSplitDNSAnswersIgnoresUnrelatedRecords(t *testing.T) {
	const name = "service.internal.example.com."
	response := testDNSResponse(t, name, "A", dnsmessage.RCodeSuccess, testDNSAddress("unrelated.example.", "203.0.113.1"))
	ips, _, err := splitDNSAnswers(response, name, dnsmessage.TypeA)
	if err != nil || len(ips) != 0 {
		t.Fatalf("answers = %v, %v; unrelated owner must not be dialed", ips, err)
	}
}

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
			var packet []byte
			if strings.HasPrefix(network, "tcp") {
				var size uint16
				if err := binary.Read(upstream, binary.BigEndian, &size); err != nil {
					return
				}
				packet = make([]byte, size)
				if _, err := io.ReadFull(upstream, packet); err != nil {
					return
				}
			} else {
				packet = make([]byte, 4096)
				n, err := upstream.Read(packet)
				if err != nil {
					return
				}
				packet = packet[:n]
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
			if strings.HasPrefix(network, "tcp") {
				_ = binary.Write(upstream, binary.BigEndian, uint16(len(packet)))
			}
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

func TestRestrictedDNSWorksWithEitherTransport(t *testing.T) {
	for _, supported := range []string{"udp", "tcp"} {
		t.Run(supported, func(t *testing.T) {
			nm := &netmap.NetworkMap{DNS: tailcfg.DNSConfig{Routes: map[string][]*dnstype.Resolver{
				"internal.example": {{Addr: "100.64.0.53"}},
			}}}
			answer := dnsTestDial(t, func(string, string, dnsmessage.Type) (netip.Addr, error) {
				return netip.MustParseAddr("10.0.0.80"), nil
			})
			addresses, matched, err := resolveRestrictedDNS(t.Context(), "tcp4", "wiki.internal.example", nm, "", func(ctx context.Context, network, address string) (net.Conn, error) {
				if network != supported {
					return nil, errors.New("transport unavailable")
				}
				return answer(ctx, network, address)
			})
			if err != nil || !matched || !slices.Equal(addresses, []netip.Addr{netip.MustParseAddr("10.0.0.80")}) {
				t.Fatalf("result = %v, %v, %v", addresses, matched, err)
			}
		})
	}
}

func TestRestrictedDNSCancellationClosesTransports(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	peers := make(chan net.Conn, 2)
	done := make(chan error, 1)
	go func() {
		_, err := queryRestrictedDNS(ctx, "wiki.internal.example.", "A", "100.64.0.53:53", func(context.Context, string, string) (net.Conn, error) {
			client, server := net.Pipe()
			peers <- server
			return client, nil
		})
		done <- err
	}()
	select {
	case peer := <-peers:
		defer peer.Close()
	case <-time.After(time.Second):
		t.Fatal("DNS transport did not start")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("canceled DNS exchange succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("canceled DNS exchange did not stop")
	}
	for len(peers) > 0 {
		(<-peers).Close()
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
