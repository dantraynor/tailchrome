package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"tailscale.com/net/netx"
	"tailscale.com/tailcfg"
	"tailscale.com/types/dnstype"
	"tailscale.com/types/netmap"
	"tailscale.com/util/race"
)

const splitDNSLookupTimeout = 5 * time.Second

type dnsQueryFunc func(context.Context, string, string) ([]byte, error)

func splitDNSMatches(host string, domains []string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, domain := range domains {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			return true
		}
	}
	return false
}

// dialWithSplitDNS resolves restricted domains through the embedded Tailscale
// resolver before dialing their IPs. An unsuccessful restricted lookup must not
// fall back to the system resolver, which may return a different public address.
func dialWithSplitDNS(ctx context.Context, network, address string, domains []string, query dnsQueryFunc, dial netx.DialFunc) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	if _, err := netip.ParseAddr(host); err == nil || !splitDNSMatches(host, domains) {
		return dial(ctx, network, address)
	}
	portNumber, err := strconv.ParseUint(port, 10, 16)
	if err != nil {
		return nil, fmt.Errorf("invalid port %q: %w", port, err)
	}
	ips, err := lookupSplitDNS(ctx, network, host, query)
	if err != nil {
		return nil, err
	}
	addrs := make([]netip.AddrPort, len(ips))
	for i, ip := range ips {
		addrs[i] = netip.AddrPortFrom(ip, uint16(portNumber))
	}
	if len(addrs) == 1 || strings.HasPrefix(network, "udp") {
		return dial(ctx, network, addrs[0].String())
	}
	return netx.RaceDial(ctx, addrs, func(ctx context.Context, _ string, address string) (net.Conn, error) {
		return dial(ctx, network, address)
	}, 300*time.Millisecond)
}

func lookupSplitDNS(ctx context.Context, network, host string, query dnsQueryFunc) ([]netip.Addr, error) {
	lookupCtx, cancel := context.WithTimeout(ctx, splitDNSLookupTimeout)
	defer cancel()
	types := []dnsmessage.Type{dnsmessage.TypeA, dnsmessage.TypeAAAA}
	switch network {
	case "tcp4", "udp4":
		types = types[:1]
	case "tcp6", "udp6":
		types = types[1:]
	}
	type result struct {
		ips []netip.Addr
		err error
	}
	results := make(chan result, len(types))
	for _, typ := range types {
		go func() {
			ips, err := lookupSplitDNSRecord(lookupCtx, host, typ, query)
			results <- result{ips, err}
		}()
	}
	var ips []netip.Addr
	var firstErr error
	for range types {
		select {
		case r := <-results:
			ips = append(ips, r.ips...)
			if firstErr == nil {
				firstErr = r.err
			}
		case <-lookupCtx.Done():
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if len(ips) > 0 {
				return ips, nil
			}
			return nil, lookupCtx.Err()
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(ips) > 0 {
		return ips, nil
	}
	if firstErr == nil {
		firstErr = &net.DNSError{Err: "no address records", Name: host, IsNotFound: true}
	}
	return nil, fmt.Errorf("split DNS lookup for %s: %w", host, firstErr)
}

func lookupSplitDNSRecord(ctx context.Context, host string, typ dnsmessage.Type, query dnsQueryFunc) ([]netip.Addr, error) {
	queryType := "A"
	if typ == dnsmessage.TypeAAAA {
		queryType = "AAAA"
	}
	name := strings.ToLower(strings.TrimSuffix(host, ".")) + "."
	seen := make(map[string]bool)
	for range 16 {
		if seen[name] {
			return nil, fmt.Errorf("DNS CNAME loop for %s", host)
		}
		seen[name] = true
		response, err := query(ctx, name, queryType)
		if err != nil {
			return nil, err
		}
		ips, canonical, err := splitDNSAnswers(response, name, typ)
		if err != nil || len(ips) > 0 || canonical == name {
			return ips, err
		}
		// Recursive resolvers normally include the address with a CNAME. If
		// they return only the alias, keep its follow-up on the internal resolver.
		name = canonical
	}
	return nil, fmt.Errorf("too many DNS CNAME redirects for %s", host)
}

func splitDNSAnswers(response []byte, name string, typ dnsmessage.Type) ([]netip.Addr, string, error) {
	var message dnsmessage.Message
	if err := message.Unpack(response); err != nil {
		return nil, name, fmt.Errorf("invalid DNS response: %w", err)
	}
	if !message.Response || message.Truncated {
		return nil, name, fmt.Errorf("incomplete DNS response for %s", name)
	}
	if message.RCode != dnsmessage.RCodeSuccess {
		return nil, name, &net.DNSError{
			Err:        message.RCode.String(),
			Name:       name,
			IsNotFound: message.RCode == dnsmessage.RCodeNameError,
		}
	}
	if len(message.Questions) != 1 || !strings.EqualFold(message.Questions[0].Name.String(), name) || message.Questions[0].Type != typ || message.Questions[0].Class != dnsmessage.ClassINET {
		return nil, name, fmt.Errorf("DNS response question does not match %s", name)
	}
	addresses := make(map[string][]netip.Addr)
	aliases := make(map[string]string)
	for _, answer := range message.Answers {
		if answer.Header.Class != dnsmessage.ClassINET {
			continue
		}
		owner := strings.ToLower(answer.Header.Name.String())
		switch body := answer.Body.(type) {
		case *dnsmessage.AResource:
			if typ == dnsmessage.TypeA {
				addresses[owner] = append(addresses[owner], netip.AddrFrom4(body.A))
			}
		case *dnsmessage.AAAAResource:
			if typ == dnsmessage.TypeAAAA {
				addresses[owner] = append(addresses[owner], netip.AddrFrom16(body.AAAA).Unmap())
			}
		case *dnsmessage.CNAMEResource:
			aliases[owner] = strings.ToLower(body.CNAME.String())
		}
	}
	seen := make(map[string]bool)
	for range 16 {
		if seen[name] {
			return nil, name, fmt.Errorf("DNS CNAME loop for %s", name)
		}
		seen[name] = true
		if ips := addresses[name]; len(ips) > 0 {
			return ips, name, nil
		}
		alias, ok := aliases[name]
		if !ok {
			return nil, name, nil
		}
		name = alias
	}
	return nil, name, fmt.Errorf("too many DNS CNAME redirects")
}

// dnsName accepts only literal DNS names, never URLs, wildcards, or IP addresses.
func dnsName(raw string) (string, bool) {
	name := strings.ToLower(strings.TrimSuffix(raw, "."))
	if len(name) == 0 || len(name) > 253 || strings.Trim(name, "0123456789.") == "" {
		return "", false
	}
	if _, err := netip.ParseAddr(name); err == nil {
		return "", false
	}
	for _, label := range strings.Split(name, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", false
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return "", false
			}
		}
	}
	return name, true
}

// restrictedDNSRoutes mirrors Tailscale's exit-node DNS selection: when the
// selected peer can proxy DNS, only opted-in resolvers override that peer.
// Empty routes still belong to the built-in DNS records.
func restrictedDNSRoutes(nm *netmap.NetworkMap, exitNodeID string) map[string][]*dnstype.Resolver {
	if nm == nil {
		return nil
	}
	useExitDNS := false
	for _, peer := range nm.Peers {
		if !peer.Valid() || exitNodeID == "" || string(peer.StableID()) != exitNodeID {
			continue
		}
		useExitDNS = peer.Cap() >= 26
		if !useExitDNS && peer.Hostinfo().Valid() {
			for _, service := range peer.Hostinfo().Services().All() {
				if service.Proto == tailcfg.PeerAPIDNS && service.Port >= 1 {
					useExitDNS = true
					break
				}
			}
		}
		break
	}
	if !useExitDNS {
		return nm.DNS.Routes
	}
	routes := make(map[string][]*dnstype.Resolver)
	for domain, resolvers := range nm.DNS.Routes {
		if len(resolvers) == 0 {
			routes[domain] = nil
			continue
		}
		for _, resolver := range resolvers {
			if resolver != nil && resolver.UseWithExitNode {
				routes[domain] = append(routes[domain], resolver)
			}
		}
	}
	return routes
}

func dnsRouteDomains(nm *netmap.NetworkMap, exitNodeID string) []string {
	return dnsDomains(restrictedDNSRoutes(nm, exitNodeID))
}

func dnsDomains(routes map[string][]*dnstype.Resolver) []string {
	domains := []string{}
	seen := map[string]bool{}
	for raw := range routes {
		if domain, ok := dnsName(raw); ok && !seen[domain] {
			seen[domain] = true
			domains = append(domains, domain)
		}
	}
	sort.Strings(domains)
	return domains
}

// resolveRestrictedDNS resolves through the most specific configured DNS route.
// Dial is bound to the same tsnet session as nm. Callers must validate the returned
// addresses against their destination policy and dial a literal address, so a
// later DNS answer cannot change the destination after that check.
func resolveRestrictedDNS(ctx context.Context, network, hostname string, nm *netmap.NetworkMap, exitNodeID string, dial func(context.Context, string, string) (net.Conn, error)) ([]netip.Addr, bool, error) {
	host, ok := dnsName(hostname)
	if !ok || nm == nil {
		return nil, false, nil
	}
	routes := restrictedDNSRoutes(nm, exitNodeID)
	matched := ""
	for _, domain := range dnsDomains(routes) {
		if (host == domain || strings.HasSuffix(host, "."+domain)) && len(domain) > len(matched) {
			matched = domain
		}
	}
	if matched == "" {
		return nil, false, nil
	}
	// Keep lookup order deterministic even if a map contains duplicate normalized keys.
	keys := make([]string, 0, len(routes))
	for key := range routes {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	servers := []string{}
	for _, key := range keys {
		if domain, valid := dnsName(key); !valid || domain != matched {
			continue
		}
		resolvers := routes[key]
		if len(resolvers) == 0 {
			// Empty routes belong to Tailscale's in-memory DNS records.
			return nil, false, nil
		}
		for _, resolver := range resolvers {
			if resolver == nil {
				continue
			}
			ipp, valid := resolver.IPPort()
			if !valid || ipp.Port() == 0 || !validDNSAddress(ipp.Addr()) {
				continue
			}
			servers = append(servers, netip.AddrPortFrom(ipp.Addr().Unmap(), ipp.Port()).String())
		}
	}
	if len(servers) == 0 {
		return nil, true, fmt.Errorf("split DNS route %q has no supported IP nameserver", matched)
	}
	addresses, err := lookupSplitDNS(ctx, network, host, func(ctx context.Context, name, queryType string) ([]byte, error) {
		var lastErr error
		for _, server := range servers {
			// Bound each server attempt, leaving time for configured alternates.
			attemptCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			wire, err := queryRestrictedDNS(attemptCtx, name, queryType, server, dial)
			cancel()
			if err == nil {
				return wire, nil
			}
			lastErr = err
			if ctx.Err() != nil {
				break
			}
		}
		return nil, lastErr
	})
	if err != nil {
		return nil, true, err
	}
	for _, address := range addresses {
		if !validDNSAddress(address) {
			return nil, true, fmt.Errorf("split DNS returned an invalid destination")
		}
	}
	return addresses, true, nil
}

// queryRestrictedDNS matches the embedded resolver's UDP/TCP race while binding
// both transports to the caller's authorized nameserver dial. A separate wire
// exchange prevents the resolver from falling back to the host network.
func queryRestrictedDNS(ctx context.Context, name, queryType, server string, dial netx.DialFunc) ([]byte, error) {
	typ := dnsmessage.TypeA
	if queryType == "AAAA" {
		typ = dnsmessage.TypeAAAA
	}
	dnsName, err := dnsmessage.NewName(name)
	if err != nil {
		return nil, err
	}
	var randomID [2]byte
	if _, err := rand.Read(randomID[:]); err != nil {
		return nil, err
	}
	id := binary.BigEndian.Uint16(randomID[:])
	message := dnsmessage.Message{
		Header:    dnsmessage.Header{ID: id, RecursionDesired: true},
		Questions: []dnsmessage.Question{{Name: dnsName, Type: typ, Class: dnsmessage.ClassINET}},
	}
	packet, err := message.Pack()
	if err != nil {
		return nil, err
	}
	exchange := func(ctx context.Context, network string) ([]byte, error) {
		conn, err := dial(ctx, network, server)
		if err != nil {
			return nil, err
		}
		defer conn.Close()
		stop := context.AfterFunc(ctx, func() { conn.Close() })
		defer stop()
		var response []byte
		if network == "tcp" {
			framed := make([]byte, 2+len(packet))
			binary.BigEndian.PutUint16(framed, uint16(len(packet)))
			copy(framed[2:], packet)
			if _, err := conn.Write(framed); err != nil {
				return nil, err
			}
			var size uint16
			if err := binary.Read(conn, binary.BigEndian, &size); err != nil {
				return nil, err
			}
			response = make([]byte, size)
			if _, err := io.ReadFull(conn, response); err != nil {
				return nil, err
			}
		} else {
			if _, err := conn.Write(packet); err != nil {
				return nil, err
			}
			response = make([]byte, 65536)
			n, err := conn.Read(response)
			if err != nil {
				return nil, err
			}
			response = response[:n]
		}
		if len(response) < 12 || len(response) > 65535 || binary.BigEndian.Uint16(response) != id {
			return nil, fmt.Errorf("DNS response has invalid length or transaction ID")
		}
		// Reject truncation and invalid answers before choosing a race winner.
		if _, _, err := splitDNSAnswers(response, name, typ); err != nil {
			return nil, err
		}
		return response, nil
	}
	return race.New(0,
		func(ctx context.Context) ([]byte, error) { return exchange(ctx, "udp") },
		func(ctx context.Context) ([]byte, error) { return exchange(ctx, "tcp") },
	).Start(ctx)
}

func validDNSAddress(ip netip.Addr) bool {
	ip = ip.Unmap()
	return ip.IsGlobalUnicast() && !ip.IsLoopback() && ip.Zone() == ""
}
