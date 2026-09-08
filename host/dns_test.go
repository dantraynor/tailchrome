package main

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
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
