package main

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"sort"
	"strings"
	"time"

	"tailscale.com/tailcfg"
	"tailscale.com/types/dnstype"
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
