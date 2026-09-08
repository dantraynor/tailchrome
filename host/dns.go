package main

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"sort"
	"strings"
	"time"

	"tailscale.com/types/netmap"
)

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

func dnsRouteDomains(nm *netmap.NetworkMap) []string {
	domains := []string{}
	if nm == nil {
		return domains
	}
	seen := map[string]bool{}
	for raw := range nm.DNS.Routes {
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
func resolveRestrictedDNS(ctx context.Context, network, hostname string, nm *netmap.NetworkMap, dial func(context.Context, string, string) (net.Conn, error)) ([]netip.Addr, bool, error) {
	host, ok := dnsName(hostname)
	if !ok || nm == nil {
		return nil, false, nil
	}
	matched := ""
	for _, domain := range dnsRouteDomains(nm) {
		if (host == domain || strings.HasSuffix(host, "."+domain)) && len(domain) > len(matched) {
			matched = domain
		}
	}
	if matched == "" {
		return nil, false, nil
	}
	// Keep lookup order deterministic even if a map contains duplicate normalized keys.
	keys := make([]string, 0, len(nm.DNS.Routes))
	for key := range nm.DNS.Routes {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	servers := []string{}
	for _, key := range keys {
		if domain, valid := dnsName(key); !valid || domain != matched {
			continue
		}
		resolvers := nm.DNS.Routes[key]
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
	queryNetwork := "ip"
	if strings.HasSuffix(network, "4") {
		queryNetwork = "ip4"
	} else if strings.HasSuffix(network, "6") {
		queryNetwork = "ip6"
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var lastErr error
	for _, server := range servers {
		// Bound each server attempt, leaving time to try the configured alternates.
		attemptCtx, attemptCancel := context.WithTimeout(ctx, 3*time.Second)
		resolver := &net.Resolver{
			PreferGo:     true,
			StrictErrors: true,
			Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
				return dial(ctx, network, server)
			},
		}
		// A trailing dot prevents local search-domain expansion.
		addresses, err := resolver.LookupNetIP(attemptCtx, queryNetwork, host+".")
		attemptCancel()
		if err == nil && len(addresses) > 0 {
			for i, address := range addresses {
				address = address.Unmap()
				if !validDNSAddress(address) {
					return nil, true, fmt.Errorf("split DNS returned an invalid destination")
				}
				addresses[i] = address
			}
			return addresses, true, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			break
		}
	}
	return nil, true, fmt.Errorf("split DNS lookup failed for %q: %w", host, lastErr)
}

func validDNSAddress(ip netip.Addr) bool {
	ip = ip.Unmap()
	return ip.IsGlobalUnicast() && !ip.IsLoopback() && ip.Zone() == ""
}
