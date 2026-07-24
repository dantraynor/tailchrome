package main

import (
	"net/netip"
	"testing"
	"time"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/types/views"
)

func TestPeerStatusToPeerInfoCopiesRoutingAndIdentityFields(t *testing.T) {
	expiry := time.Date(2027, 1, 2, 3, 4, 5, 0, time.UTC)
	routes := views.SliceOf([]netip.Prefix{netip.MustParsePrefix("10.20.0.0/16")})
	tags := views.SliceOf([]string{"tag:server"})
	peer := &ipnstate.PeerStatus{
		ID:             tailcfg.StableNodeID("node-1"),
		HostName:       "server",
		DNSName:        "server.example.ts.net.",
		OS:             "linux",
		UserID:         tailcfg.UserID(42),
		TailscaleIPs:   []netip.Addr{netip.MustParseAddr("100.64.0.8"), netip.MustParseAddr("fd7a:115c:a1e0::8")},
		Tags:           &tags,
		PrimaryRoutes:  &routes,
		Online:         true,
		Active:         true,
		ExitNodeOption: true,
		KeyExpiry:      &expiry,
		SSH_HostKeys:   []string{"ssh-ed25519 AAAA"},
	}
	status := &ipnstate.Status{User: map[tailcfg.UserID]tailcfg.UserProfile{
		42: {ID: 42, LoginName: "owner@example.com", DisplayName: "Owner"},
	}}

	got := peerStatusToPeerInfo(peer, status)

	if !got.IsSubnetRouter || len(got.Subnets) != 1 || got.Subnets[0] != "10.20.0.0/16" {
		t.Fatalf("subnet conversion failed: %#v", got.Subnets)
	}
	if len(got.TailscaleIPs) != 2 || got.TailscaleIPs[1] != "fd7a:115c:a1e0::8" {
		t.Fatalf("IP conversion failed: %#v", got.TailscaleIPs)
	}
	if got.KeyExpiry != expiry.Format(time.RFC3339) || !got.SSHHost {
		t.Fatalf("capability conversion failed: %#v", got)
	}
	if got.UserLoginName != "owner@example.com" || got.UserName != "Owner" {
		t.Fatalf("user conversion failed: %#v", got)
	}
	if len(got.Tags) != 1 || got.Tags[0] != "tag:server" {
		t.Fatalf("tag conversion failed: %#v", got.Tags)
	}
}
