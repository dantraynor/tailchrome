package main

import (
	"context"
	"net"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/ipn/store/mem"
	"tailscale.com/net/netns"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/dnstype"
	"tailscale.com/types/logger"
)

// Use the real notification bus: synthetic NetMap notifications do not cover
// the notification formats emitted by the pinned Tailscale version.
func TestWatchIPNBusPublishesControlPlaneDNSChanges(t *testing.T) {
	if testing.Short() {
		t.Skip("starts an embedded tailnet node")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })
	dnsConfig := func(domain string) *tailcfg.DNSConfig {
		config := &tailcfg.DNSConfig{Proxied: true, Routes: map[string][]*dnstype.Resolver{}}
		if domain != "" {
			config.Routes[domain] = []*dnstype.Resolver{{Addr: "192.0.2.53"}}
		}
		return config
	}
	control := &testcontrol.Server{
		DERPMap:        splitDNSTestDERP(t),
		DNSConfig:      dnsConfig("internal.example.com"),
		MagicDNSDomain: "test.ts.net",
		Logf:           logger.Discard,
	}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	t.Cleanup(control.HTTPTestServer.Close)
	node := &tsnet.Server{
		Dir: t.TempDir(), Hostname: "dns-status-client", ControlURL: control.HTTPTestServer.URL,
		Store: new(mem.Store), Ephemeral: true, Logf: logger.Discard,
	}
	t.Cleanup(func() { node.Close() })
	status, err := node.Up(ctx)
	if err != nil {
		t.Fatal(err)
	}
	lc, err := node.LocalClient()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lc.EditPrefs(ctx, &ipn.MaskedPrefs{
		Prefs: ipn.Prefs{CorpDNS: true}, CorpDNSSet: true,
	}); err != nil {
		t.Fatal(err)
	}

	writer, reader := net.Pipe()
	defer writer.Close()
	defer reader.Close()
	h := newHost(nil, writer)
	h.ts, h.lc = node, lc
	watchCtx, stopWatch := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- h.watchIPNBusSession(watchCtx, lc, 0) }()
	defer func() {
		stopWatch()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("IPN watcher did not stop")
		}
	}()
	waitForDomains := func(t *testing.T, want []string) {
		t.Helper()
		if err := reader.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
			t.Fatal(err)
		}
		for {
			reply := decodeReply(t, reader)
			if reply.Status == nil || !slices.Equal(reply.Status.SplitDNSDomains, want) {
				continue
			}
			if reply.Status.SplitDNSDomains == nil {
				t.Fatal("removed DNS domains must be published as [], not null or omitted")
			}
			return
		}
	}
	waitForDomains(t, []string{"internal.example.com"})
	for _, test := range []struct {
		name   string
		domain string
		want   []string
	}{
		{"replacement", "replacement.example.com", []string{"replacement.example.com"}},
		{"removal", "", []string{}},
	} {
		if !t.Run(test.name, func(t *testing.T) {
			if !control.AddRawMapResponse(status.Self.PublicKey, &tailcfg.MapResponse{
				DNSConfig: dnsConfig(test.domain),
			}) {
				t.Fatal("control-plane DNS update was not enqueued")
			}
			waitForDomains(t, test.want)
		}) {
			return
		}
	}
}
