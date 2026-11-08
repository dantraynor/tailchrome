package main

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"tailscale.com/net/netns"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/dnstype"
	"tailscale.com/types/logger"
)

// TestInitRestoresSavedControlURL mirrors handleInit: the saved control URL
// must survive tsnet.Start, which otherwise resets ControlURL to the default.
func TestInitRestoresSavedControlURL(t *testing.T) {
	if testing.Short() {
		t.Skip("starts an embedded tailnet node")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })

	control := &testcontrol.Server{
		DERPMap:        splitDNSTestDERP(t),
		DNSConfig:      &tailcfg.DNSConfig{Proxied: true, Routes: map[string][]*dnstype.Resolver{}},
		MagicDNSDomain: "test.ts.net",
		Logf:           logger.Discard,
	}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	t.Cleanup(control.HTTPTestServer.Close)

	stateDir := t.TempDir()
	if err := writeSavedControlURL(stateDir, control.HTTPTestServer.URL); err != nil {
		t.Fatalf("writeSavedControlURL: %v", err)
	}

	// Same construction as handleInit; tsnet keeps its own state files in the
	// dir alongside the sidecar.
	node := &tsnet.Server{
		Dir:          stateDir,
		Hostname:     "browser-ext",
		RunWebClient: true,
		ControlURL:   readSavedControlURL(stateDir),
		Logf:         logger.Discard,
	}
	t.Cleanup(func() { node.Close() })

	if err := node.Start(); err != nil {
		t.Fatalf("tsnet.Start: %v", err)
	}
	lc, err := node.LocalClient()
	if err != nil {
		t.Fatalf("LocalClient: %v", err)
	}
	prefs, err := lc.GetPrefs(ctx)
	if err != nil {
		t.Fatalf("GetPrefs: %v", err)
	}
	if got, want := controlURLCompareKey(prefs.ControlURL), controlURLCompareKey(control.HTTPTestServer.URL); got != want {
		t.Fatalf("ControlURL after Start = %q (key %q), want saved custom URL (key %q)", prefs.ControlURL, got, want)
	}
}
