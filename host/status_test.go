package main

import (
	"net/netip"
	"testing"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
)

func TestBuildStatusUpdateUsesAuthURLFallback(t *testing.T) {
	h := newHost(nil, nil)
	st := &ipnstate.Status{
		BackendState: "NeedsLogin",
		AuthURL:      "https://login.tailscale.com/a/from-status",
	}

	update := h.buildStatusUpdate(st)

	if update.BrowseToURL != st.AuthURL {
		t.Fatalf("BrowseToURL = %q, want %q", update.BrowseToURL, st.AuthURL)
	}
	if update.AuthURL != st.AuthURL {
		t.Fatalf("AuthURL = %q, want %q", update.AuthURL, st.AuthURL)
	}
}

func TestBuildStatusUpdatePrefersCachedBrowseToURL(t *testing.T) {
	h := newHost(nil, nil)
	h.lastBrowseToURL = "https://login.tailscale.com/a/from-ipn"
	st := &ipnstate.Status{
		BackendState: "NeedsLogin",
		AuthURL:      "https://login.tailscale.com/a/from-status",
	}

	update := h.buildStatusUpdate(st)

	if update.BrowseToURL != h.lastBrowseToURL {
		t.Fatalf("BrowseToURL = %q, want %q", update.BrowseToURL, h.lastBrowseToURL)
	}
	if update.AuthURL != st.AuthURL {
		t.Fatalf("AuthURL = %q, want %q", update.AuthURL, st.AuthURL)
	}
}

func TestClearCachedStatusResetsVolatileFieldsAndKeepsPrefs(t *testing.T) {
	h := newHost(nil, nil)
	h.lastState = "Running"
	h.lastBrowseToURL = "https://login.tailscale.com/a/old"
	h.lastHealth = []string{"old warning"}
	h.lastPrefs = &PrefsView{ControlURL: "https://old.example.com"}

	prefs := &ipn.Prefs{
		ControlURL:  "https://hs.example.com",
		WantRunning: true,
		CorpDNS:     true,
	}
	h.clearCachedStatus(prefs)

	if h.lastState != "" {
		t.Fatalf("lastState = %q, want empty", h.lastState)
	}
	if h.lastBrowseToURL != "" {
		t.Fatalf("lastBrowseToURL = %q, want empty", h.lastBrowseToURL)
	}
	if h.lastHealth != nil {
		t.Fatalf("lastHealth = %#v, want nil", h.lastHealth)
	}
	if h.lastPrefs == nil {
		t.Fatal("lastPrefs = nil, want prefs view")
	}
	if h.lastPrefs.ControlURL != prefs.ControlURL {
		t.Fatalf("ControlURL = %q, want %q", h.lastPrefs.ControlURL, prefs.ControlURL)
	}
	if !h.lastPrefs.WantRunning {
		t.Fatal("WantRunning = false, want true")
	}
}

func TestPrefsViewFromIPNIncludesControlURLAndAdvertisedRoutes(t *testing.T) {
	route := netip.MustParsePrefix("10.0.0.0/24")
	prefs := &ipn.Prefs{
		ControlURL:             "https://hs.example.com",
		RouteAll:               true,
		ExitNodeID:             tailcfg.StableNodeID("node-1"),
		ExitNodeAllowLANAccess: true,
		CorpDNS:                true,
		WantRunning:            true,
		ShieldsUp:              true,
		Hostname:               "browser-ext",
		RunSSH:                 true,
		RunWebClient:           true,
		AdvertiseRoutes:        []netip.Prefix{route},
	}
	prefs.SetAdvertiseExitNode(true)

	pv := prefsViewFromIPN(prefs.View())

	if pv.ControlURL != prefs.ControlURL {
		t.Fatalf("ControlURL = %q, want %q", pv.ControlURL, prefs.ControlURL)
	}
	if !pv.RouteAll || !pv.ExitNodeAllowLANAccess || !pv.CorpDNS || !pv.WantRunning || !pv.ShieldsUp || !pv.RunSSH || !pv.RunWebClient {
		t.Fatalf("boolean prefs not copied correctly: %#v", pv)
	}
	if pv.Hostname != prefs.Hostname {
		t.Fatalf("Hostname = %q, want %q", pv.Hostname, prefs.Hostname)
	}
	if pv.ExitNodeID != string(prefs.ExitNodeID) {
		t.Fatalf("ExitNodeID = %q, want %q", pv.ExitNodeID, prefs.ExitNodeID)
	}
	if !pv.AdvertiseExitNode {
		t.Fatal("AdvertiseExitNode = false, want true")
	}
	foundRoute := false
	for _, got := range pv.AdvertiseRoutes {
		if got == route.String() {
			foundRoute = true
		}
	}
	if !foundRoute {
		t.Fatalf("AdvertiseRoutes = %#v, want route %q", pv.AdvertiseRoutes, route)
	}
}
