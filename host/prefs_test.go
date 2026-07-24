package main

import (
	"encoding/json"
	"net/netip"
	"strings"
	"testing"

	"tailscale.com/ipn"
)

func TestMaskedPrefsForUpdatePreservesExitNodeAdvertising(t *testing.T) {
	current := &ipn.Prefs{
		AdvertiseRoutes: []netip.Prefix{netip.MustParsePrefix("10.10.0.0/16")},
	}
	current.SetAdvertiseExitNode(true)
	originalRoutes := append([]netip.Prefix(nil), current.AdvertiseRoutes...)

	partial, err := decodePartialPrefs(json.RawMessage(`{
		"advertiseRoutes":["10.20.0.0/16"],
		"wantRunning":true,
		"hostname":"browser-node"
	}`))
	if err != nil {
		t.Fatal(err)
	}
	mp, changedControlURL, err := maskedPrefsForUpdate(partial, current)
	if err != nil {
		t.Fatal(err)
	}

	if changedControlURL {
		t.Fatal("control URL reported changed for a route-only update")
	}
	if !mp.AdvertiseRoutesSet || !mp.WantRunningSet || !mp.Prefs.WantRunning || !mp.HostnameSet || mp.Prefs.Hostname != "browser-node" {
		t.Fatalf("masked preference fields were not mapped: %#v", mp)
	}
	for _, want := range []netip.Prefix{
		netip.MustParsePrefix("10.20.0.0/16"),
		netip.MustParsePrefix("0.0.0.0/0"),
		netip.MustParsePrefix("::/0"),
	} {
		if !containsPrefix(mp.Prefs.AdvertiseRoutes, want) {
			t.Fatalf("AdvertiseRoutes = %#v, missing %s", mp.Prefs.AdvertiseRoutes, want)
		}
	}
	if len(current.AdvertiseRoutes) != len(originalRoutes) {
		t.Fatalf("current prefs were mutated: got %#v, want %#v", current.AdvertiseRoutes, originalRoutes)
	}
	for i := range originalRoutes {
		if current.AdvertiseRoutes[i] != originalRoutes[i] {
			t.Fatalf("current prefs were mutated: got %#v, want %#v", current.AdvertiseRoutes, originalRoutes)
		}
	}
}

func TestMaskedPrefsForUpdateRejectsInvalidAdvertiseRoute(t *testing.T) {
	partial, err := decodePartialPrefs(json.RawMessage(`{"advertiseRoutes":["not-a-cidr"]}`))
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = maskedPrefsForUpdate(partial, &ipn.Prefs{})
	if err == nil || !strings.Contains(err.Error(), "invalid advertise route CIDR") {
		t.Fatalf("error = %v, want invalid-CIDR error", err)
	}
}

func containsPrefix(prefixes []netip.Prefix, want netip.Prefix) bool {
	for _, prefix := range prefixes {
		if prefix == want {
			return true
		}
	}
	return false
}
