package main

import (
	"context"
	"net/http/httptest"
	"net/netip"
	"slices"
	"testing"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/ipn/store/mem"
	"tailscale.com/net/netns"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/logger"
)

func writeTestProfile(t *testing.T, st ipn.StateStore, current, known, prefs string) {
	t.Helper()
	if current != "" {
		if err := st.WriteState(ipn.CurrentProfileStateKey, []byte(current)); err != nil {
			t.Fatal(err)
		}
	}
	if known != "" {
		if err := st.WriteState(ipn.KnownProfilesStateKey, []byte(known)); err != nil {
			t.Fatal(err)
		}
	}
	if prefs != "" {
		if err := st.WriteState("profile-a1", []byte(prefs)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestLoadSavedProfilePrefsWithoutProfile(t *testing.T) {
	saved, err := loadSavedProfilePrefs(new(mem.Store))
	if err != nil || saved != nil {
		t.Fatalf("loadSavedProfilePrefs = %v, %v; want nil, nil", saved, err)
	}
	if got := restoredStartupPrefs(nil); !got.RouteAllSet || !got.RouteAll || got.ShieldsUpSet {
		t.Fatalf("new profiles must only get startup defaults, got %v", got.Pretty())
	}
	if savedHostname(nil) != "browser-ext" || savedControlURL(nil) != "" {
		t.Fatal("new profiles must keep tsnet's default hostname and control URL")
	}
}

func TestLoadSavedProfilePrefsIgnoresUnknownCurrentProfile(t *testing.T) {
	st := new(mem.Store)
	writeTestProfile(t, st, "profile-a1", `{"b2":{"ID":"b2","Key":"profile-b2"}}`, `{"ShieldsUp":true}`)
	saved, err := loadSavedProfilePrefs(st)
	if err != nil || saved != nil {
		t.Fatalf("loadSavedProfilePrefs = %v, %v; want nil, nil", saved, err)
	}
}

func TestLoadSavedProfilePrefsSkipsNodeIdentity(t *testing.T) {
	st := new(mem.Store)
	writeTestProfile(t, st, "profile-a1", `{"a1":{"ID":"a1","Key":"profile-a1"}}`, `{
		"ControlURL": "https://headscale.example.com",
		"Hostname": "work-browser",
		"RouteAll": false,
		"ShieldsUp": true,
		"Config": {"AttestationKey": {"unexpected": "tpm-blob"}}
	}`)
	saved, err := loadSavedProfilePrefs(st)
	if err != nil {
		t.Fatal(err)
	}
	if saved == nil || saved.Persist != nil {
		t.Fatalf("saved prefs = %v; want prefs without node identity", saved)
	}
	if got := savedControlURL(saved); got != "https://headscale.example.com" {
		t.Fatalf("savedControlURL = %q", got)
	}
	if got := savedHostname(saved); got != "work-browser" {
		t.Fatalf("savedHostname = %q", got)
	}
	mp := restoredStartupPrefs(saved)
	if !mp.RouteAllSet || mp.RouteAll || !mp.ShieldsUpSet || !mp.ShieldsUp {
		t.Fatalf("restored prefs = %v; want the saved RouteAll and ShieldsUp", mp.Pretty())
	}
	if mp.ControlURLSet || mp.HostnameSet || mp.WantRunningSet || mp.ExitNodeIDSet {
		t.Fatalf("restored prefs = %v; must leave control URL, hostname, run state, and exit node alone", mp.Pretty())
	}
}

func TestLoadSavedProfilePrefsTreatsDefaultControlURLAsUnset(t *testing.T) {
	st := new(mem.Store)
	writeTestProfile(t, st, "profile-a1", `{"a1":{"ID":"a1","Key":"profile-a1"}}`, `{"ControlURL":"https://controlplane.tailscale.com"}`)
	saved, err := loadSavedProfilePrefs(st)
	if err != nil {
		t.Fatal(err)
	}
	if got := savedControlURL(saved); got != "" {
		t.Fatalf("savedControlURL = %q; want tsnet to keep choosing the default", got)
	}
}

// TestNewProfileServerRestoresPrefsAfterRestart restarts a logged-in node from
// the same state directory and checks that the settings a user changed survive
// tsnet.Server.Start resetting them (#153).
func TestNewProfileServerRestoresPrefsAfterRestart(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
	defer cancel()
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })

	control := &testcontrol.Server{DERPMap: splitDNSTestDERP(t), Logf: logger.Discard}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	t.Cleanup(control.HTTPTestServer.Close)
	controlURL := control.HTTPTestServer.URL
	stateDir := t.TempDir()
	route := netip.MustParsePrefix("10.9.0.0/24")

	first, saved, err := newProfileServer(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if saved != nil {
		t.Fatalf("fresh state directory returned saved prefs %v", saved.Pretty())
	}
	first.ControlURL = controlURL // the custom coordination server chosen by the user
	first.Logf = logger.Discard
	if _, err := first.Up(ctx); err != nil {
		t.Fatal(err)
	}
	lc, err := first.LocalClient()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lc.EditPrefs(ctx, &ipn.MaskedPrefs{
		Prefs: ipn.Prefs{
			Hostname:               "work-browser",
			RouteAll:               false,
			CorpDNS:                false,
			ShieldsUp:              true,
			ExitNodeAllowLANAccess: true,
			AdvertiseRoutes:        []netip.Prefix{route},
		},
		HostnameSet:               true,
		RouteAllSet:               true,
		CorpDNSSet:                true,
		ShieldsUpSet:              true,
		ExitNodeAllowLANAccessSet: true,
		AdvertiseRoutesSet:        true,
	}); err != nil {
		t.Fatal(err)
	}
	first.Close()

	second, saved, err := newProfileServer(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if second.ControlURL != controlURL || second.Hostname != "work-browser" {
		t.Fatalf("restarted server control URL %q hostname %q; want %q and work-browser", second.ControlURL, second.Hostname, controlURL)
	}
	second.Logf = logger.Discard
	t.Cleanup(func() { second.Close() })
	if _, err := second.Up(ctx); err != nil {
		t.Fatalf("restarted node did not come back up on the saved control server: %v", err)
	}
	lc, err = second.LocalClient()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lc.EditPrefs(ctx, restoredStartupPrefs(saved)); err != nil {
		t.Fatal(err)
	}
	got, err := lc.GetPrefs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.ControlURL != controlURL || got.Hostname != "work-browser" {
		t.Fatalf("after restart control URL %q hostname %q", got.ControlURL, got.Hostname)
	}
	if got.RouteAll || got.CorpDNS || !got.ShieldsUp || !got.ExitNodeAllowLANAccess {
		t.Fatalf("after restart prefs = %v; want saved RouteAll, CorpDNS, ShieldsUp, and LAN access", got.Pretty())
	}
	if !slices.Contains(got.AdvertiseRoutes, route) {
		t.Fatalf("after restart advertised routes = %v; want %v", got.AdvertiseRoutes, route)
	}
}
