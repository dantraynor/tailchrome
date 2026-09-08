package main

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"tailscale.com/net/netx"
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
