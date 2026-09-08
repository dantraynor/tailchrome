package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/net/netx"
	"tailscale.com/net/tsaddr"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/types/netmap"
)

var errProxyDestinationDenied = errors.New("destination is not permitted by the current routing policy")

// These addresses must never become reachable via a broad subnet advertisement.
var forbiddenProxyRanges = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("::/128"),
	netip.MustParsePrefix("::1/128"), netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("ff00::/8"),
}

func safeProxyIP(ip netip.Addr) bool {
	if !ip.IsValid() || ip.Zone() != "" {
		return false
	}
	ip = ip.Unmap()
	for _, p := range forbiddenProxyRanges {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

func safeProxyRoute(p netip.Prefix) bool {
	if !p.IsValid() || p.Bits() == 0 || p.Addr().Is4In6() {
		return false
	}
	for _, blocked := range forbiddenProxyRanges {
		if p.Overlaps(blocked) {
			return false
		}
	}
	return true
}

// Only primary routes authorized in AllowedIPs are accepted; advertisements and
// the extension's truncated peer list are not an authorization source.
func approvedProxySubnet(nm *netmap.NetworkMap, ip netip.Addr) bool {
	for _, peer := range nm.Peers {
		for _, primary := range peer.PrimaryRoutes().All() {
			if !safeProxyRoute(primary) || !primary.Contains(ip) {
				continue
			}
			for _, allowed := range peer.AllowedIPs().All() {
				if allowed == primary {
					return true
				}
			}
		}
	}
	return false
}

func selectedExitRoutesIP(nm *netmap.NetworkMap, prefs *ipn.Prefs, ip netip.Addr) bool {
	if prefs.ExitNodeID == "" {
		return false
	}
	for _, peer := range nm.Peers {
		if peer.StableID() != prefs.ExitNodeID {
			continue
		}
		for _, p := range peer.AllowedIPs().All() {
			if p.Bits() == 0 && p.Contains(ip) {
				return true
			}
		}
	}
	return false
}

func proxyIPAllowed(nm *netmap.NetworkMap, prefs *ipn.Prefs, ip netip.Addr, lan []netip.Prefix) (allowed, localLAN bool) {
	ip = ip.Unmap()
	if nm == nil || prefs == nil || !prefs.WantRunning || !safeProxyIP(ip) {
		return false, false
	}
	if tsaddr.IsTailscaleIP(ip) {
		return true, false
	}
	if prefs.RouteAll && approvedProxySubnet(nm, ip) {
		return true, false
	}
	if prefs.ExitNodeID != "" && prefs.ExitNodeAllowLANAccess && ip.IsPrivate() {
		for _, p := range lan {
			if p.Contains(ip) {
				return true, true
			}
		}
	}
	if !ip.IsPrivate() && selectedExitRoutesIP(nm, prefs, ip) {
		return true, false
	}
	return false, false
}

func proxyLANPrefixes() []netip.Prefix {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var prefixes []netip.Prefix
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			p, err := netip.ParsePrefix(addr.String())
			if err == nil && p.Addr().IsPrivate() && !tsaddr.IsTailscaleIP(p.Addr()) && safeProxyRoute(p) {
				prefixes = append(prefixes, p.Masked())
			}
		}
	}
	return prefixes
}

func proxyMagicDNSAddresses(nm *netmap.NetworkMap, hostname string) []netip.Addr {
	hostname = strings.ToLower(strings.TrimSuffix(hostname, "."))
	var ips []netip.Addr
	add := func(node tailcfg.NodeView) {
		if !node.Valid() {
			return
		}
		fqdn := strings.ToLower(strings.TrimSuffix(node.Name(), "."))
		short, _, _ := strings.Cut(fqdn, ".")
		if hostname != fqdn && hostname != short {
			return
		}
		for _, addr := range node.Addresses().All() {
			ips = append(ips, addr.Addr().Unmap())
		}
	}
	add(nm.SelfNode)
	for _, peer := range nm.Peers {
		add(peer)
	}
	for _, record := range nm.DNS.ExtraRecords {
		name, valid := dnsName(record.Name)
		if !valid || name != hostname || (record.Type != "" && record.Type != "A" && record.Type != "AAAA") {
			continue
		}
		if ip, err := netip.ParseAddr(record.Value); err == nil {
			ips = append(ips, ip.Unmap())
		}
	}
	return ips
}

func (h *Host) dialAllowedProxyDestination(ctx context.Context, ts *tsnet.Server, network, address string) (net.Conn, error) {
	if network != "tcp" && network != "tcp4" && network != "tcp6" {
		return nil, errProxyDestinationDenied
	}
	hostname, portText, err := net.SplitHostPort(address)
	if err != nil {
		return nil, errProxyDestinationDenied
	}
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil || port == 0 {
		return nil, errProxyDestinationDenied
	}
	currentServer, lc, generation := h.sessionSnapshot()
	if lc == nil || currentServer != ts {
		return nil, errProxyDestinationDenied
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	prefs, err := lc.GetPrefs(ctx)
	if err != nil {
		return nil, errProxyDestinationDenied
	}
	h.stateMu.Lock()
	nm := h.lastNetMap
	h.stateMu.Unlock()
	if nm == nil || !prefs.WantRunning {
		return nil, errProxyDestinationDenied
	}

	var ips []netip.Addr
	if ip, err := netip.ParseAddr(hostname); err == nil {
		ips = []netip.Addr{ip.Unmap()}
	} else if ips = proxyMagicDNSAddresses(nm, hostname); len(ips) == 0 {
		var matched bool
		if prefs.CorpDNS {
			ips, matched, err = resolveRestrictedDNS(ctx, network, hostname, nm, string(prefs.ExitNodeID), func(ctx context.Context, network, address string) (net.Conn, error) {
				h.sessionMu.RLock()
				defer h.sessionMu.RUnlock()
				if h.lc != lc || h.sessionGeneration != generation {
					return nil, errProxyDestinationDenied
				}
				currentPrefs, err := lc.GetPrefs(ctx)
				if err != nil || !sameProxyPrefs(prefs, currentPrefs) {
					return nil, errProxyDestinationDenied
				}
				return dialProxyDNS(ctx, ts, nm, prefs, network, address)
			})
		}
		if err != nil {
			return nil, errProxyDestinationDenied
		}
		if !matched {
			if prefs.ExitNodeID == "" {
				return nil, errProxyDestinationDenied
			}
			if prefs.CorpDNS {
				ips, err = queryProxyDNS(ctx, lc, hostname)
			} else {
				// Exit DNS is independent of accepting the tailnet DNS settings.
				// QueryDNS has no upstream routes when CorpDNS is disabled.
				ips, err = queryExitProxyDNS(ctx, nm, string(prefs.ExitNodeID), network, hostname, func(ctx context.Context, network, address string) (net.Conn, error) {
					h.sessionMu.RLock()
					defer h.sessionMu.RUnlock()
					if h.lc != lc || h.sessionGeneration != generation {
						return nil, errProxyDestinationDenied
					}
					return dialProxyDNSNetstack(ctx, ts, network, address)
				})
			}
			if err != nil {
				return nil, errProxyDestinationDenied
			}
		}
	}
	if len(ips) == 0 {
		return nil, errProxyDestinationDenied
	}
	currentPrefs, err := lc.GetPrefs(ctx)
	if err != nil || !sameProxyPrefs(prefs, currentPrefs) {
		return nil, errProxyDestinationDenied
	}
	status, err := lc.StatusWithoutPeers(ctx)
	if err != nil || status.BackendState != "Running" || status.Self == nil || !nm.SelfNode.Valid() || status.Self.ID != nm.SelfNode.StableID() {
		return nil, errProxyDestinationDenied
	}
	lan := proxyLANPrefixes()
	var destinations []netip.AddrPort
	localAddresses := make(map[netip.Addr]bool)
	for _, ip := range ips {
		ip = ip.Unmap()
		allowed, local := proxyIPAllowed(nm, prefs, ip, lan)
		// Validate every answer before dialing any. Never resolve the name twice.
		if !allowed {
			return nil, errProxyDestinationDenied
		}
		if (network == "tcp4" && !ip.Is4()) || (network == "tcp6" && !ip.Is6()) {
			continue
		}
		destinations = append(destinations, netip.AddrPortFrom(ip, uint16(port)))
		localAddresses[ip] = local
	}
	if len(destinations) == 0 {
		return nil, errProxyDestinationDenied
	}
	dialer := ts.Sys().Dialer.Get()
	return netx.RaceDial(ctx, destinations, func(ctx context.Context, network, address string) (net.Conn, error) {
		target, err := netip.ParseAddrPort(address)
		h.sessionMu.RLock()
		defer h.sessionMu.RUnlock()
		h.stateMu.Lock()
		currentMap := h.lastNetMap == nm
		h.stateMu.Unlock()
		if !currentMap || err != nil || h.lc != lc || h.sessionGeneration != generation {
			return nil, errProxyDestinationDenied
		}
		if localAddresses[target.Addr()] {
			// A staggered attempt may run after LAN access was disabled.
			currentPrefs, err := lc.GetPrefs(ctx)
			if err != nil || !sameProxyPrefs(prefs, currentPrefs) {
				return nil, errProxyDestinationDenied
			}
			var localDialer net.Dialer
			return localDialer.DialContext(ctx, network, target.String())
		}
		// UserDial may fall back to the OS after a route disappears. A protected
		// connection must stay in netstack even during that route-change race.
		if dialer.NetstackDialTCP == nil {
			return nil, errProxyDestinationDenied
		}
		return dialer.NetstackDialTCP(ctx, target)
	}, 300*time.Millisecond)
}

func queryProxyDNS(ctx context.Context, lc *local.Client, hostname string) ([]netip.Addr, error) {
	type result struct {
		ips []netip.Addr
		err error
	}
	results := make(chan result, 2)
	for _, queryType := range []string{"A", "AAAA"} {
		go func() {
			wire, _, err := lc.QueryDNS(ctx, hostname, queryType)
			if err != nil {
				results <- result{err: err}
				return
			}
			var message dnsmessage.Message
			if err := message.Unpack(wire); err != nil || message.Header.RCode != dnsmessage.RCodeSuccess {
				results <- result{err: fmt.Errorf("DNS query failed")}
				return
			}
			var ips []netip.Addr
			for _, answer := range message.Answers {
				switch body := answer.Body.(type) {
				case *dnsmessage.AResource:
					ips = append(ips, netip.AddrFrom4(body.A))
				case *dnsmessage.AAAAResource:
					ips = append(ips, netip.AddrFrom16(body.AAAA))
				}
			}
			results <- result{ips: ips}
		}()
	}
	var ips []netip.Addr
	for range 2 {
		r := <-results
		ips = append(ips, r.ips...)
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("DNS returned no addresses")
	}
	return ips, nil
}

// Called only for literal nameservers from the authoritative DNS configuration.
func dialProxyDNS(ctx context.Context, ts *tsnet.Server, nm *netmap.NetworkMap, prefs *ipn.Prefs, network, address string) (net.Conn, error) {
	target, err := netip.ParseAddrPort(address)
	if err != nil || !safeProxyIP(target.Addr()) {
		return nil, errProxyDestinationDenied
	}
	allowed, local := proxyIPAllowed(nm, prefs, target.Addr(), proxyLANPrefixes())
	publicDNS := !target.Addr().IsPrivate() && !tsaddr.IsTailscaleIP(target.Addr())
	if (!allowed && publicDNS && prefs.ExitNodeID == "") || local {
		var dialer net.Dialer
		return dialer.DialContext(ctx, network, target.String())
	}
	if !allowed {
		return nil, errProxyDestinationDenied
	}
	dialer := ts.Sys().Dialer.Get()
	if strings.HasPrefix(network, "udp") && dialer.NetstackDialUDP != nil {
		return dialer.NetstackDialUDP(ctx, target)
	}
	if strings.HasPrefix(network, "tcp") && dialer.NetstackDialTCP != nil {
		return dialer.NetstackDialTCP(ctx, target)
	}
	return nil, errProxyDestinationDenied
}

func sameProxyPrefs(a, b *ipn.Prefs) bool {
	return a.WantRunning == b.WantRunning && a.RouteAll == b.RouteAll && a.ExitNodeID == b.ExitNodeID && a.ExitNodeAllowLANAccess == b.ExitNodeAllowLANAccess && a.CorpDNS == b.CorpDNS && a.ControlURL == b.ControlURL
}

// Profile changes reuse tsnet. Advance the session generation before switching
// and restart the watcher afterwards so neither cached maps nor in-flight DNS
// results can authorize connections under another profile.
func (h *Host) beginProxyProfileChange(lc *local.Client) func() {
	h.sessionMu.Lock()
	if h.lc != lc {
		h.sessionMu.Unlock()
		return func() {}
	}
	oldCancel := h.watchCancel
	h.watchCancel = nil
	h.sessionGeneration++
	generation := h.sessionGeneration
	h.clearCachedStatus(nil)
	h.sessionMu.Unlock()
	if oldCancel != nil {
		oldCancel()
	}
	return func() {
		ctx, cancel := context.WithCancel(context.Background())
		h.sessionMu.Lock()
		if h.lc != lc || h.sessionGeneration != generation {
			h.sessionMu.Unlock()
			cancel()
			return
		}
		h.watchCancel = cancel
		h.sessionMu.Unlock()
		go h.watchIPNBus(ctx, lc, generation)
	}
}
