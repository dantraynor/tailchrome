package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"slices"
	"strings"
	"testing"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/types/dnstype"
	"tailscale.com/types/netmap"
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
	h.lastSplitDNSDomains = []string{"old.example.com"}

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
	if h.lastSplitDNSDomains != nil {
		t.Fatal("DNS routes from the previous session were retained")
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

func TestConfiguredSplitDNSDomains(t *testing.T) {
	config := &tailcfg.DNSConfig{Routes: map[string][]*dnstype.Resolver{
		"INTERNAL.Example.com.":                  {{Addr: "192.168.1.53"}},
		"internal.example.com":                   {{Addr: "192.168.1.54"}},
		"records.example.com":                    nil,
		"home":                                   {},
		".":                                      {{Addr: "1.1.1.1"}},
		"":                                       nil,
		".example.com":                           nil,
		"example.com..":                          nil,
		"bad..example.com":                       nil,
		"https://example.com":                    nil,
		"bad\".example.com":                      nil,
		"-bad.example.com":                       nil,
		strings.Repeat("a", 64) + ".example.com": nil,
	}}
	want := []string{"home", "internal.example.com", "records.example.com"}
	if got := configuredSplitDNSDomains(config); !slices.Equal(got, want) {
		t.Fatalf("domains = %q, want %q", got, want)
	}
}

// Exercise the actual notification-to-native-message path, including updates
// that contain no state/peer changes and preferences that disable DNS routing.
func TestWatchIPNBusPublishesSplitDNSChanges(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	notifications := make(chan ipn.Notify)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/localapi/v0/watch-ipn-bus":
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			for {
				select {
				case <-r.Context().Done():
					return
				case n := <-notifications:
					if err := json.NewEncoder(w).Encode(n); err != nil {
						return
					}
					w.(http.Flusher).Flush()
				}
			}
		case "/localapi/v0/status":
			json.NewEncoder(w).Encode(&ipnstate.Status{BackendState: "Running"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer api.Close()
	lc := &local.Client{OmitAuth: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, api.Listener.Addr().String())
	}}
	writer, reader := net.Pipe()
	defer writer.Close()
	defer reader.Close()
	h := newHost(nil, writer)
	h.lc = lc
	done := make(chan error, 1)
	go func() { done <- h.watchIPNBusSession(ctx, lc, 0) }()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("IPN watcher did not stop")
		}
	}()
	update := func(n ipn.Notify, want []string) {
		t.Helper()
		select {
		case notifications <- n:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		reader.SetReadDeadline(time.Now().Add(2 * time.Second))
		reply := decodeReply(t, reader)
		if reply.Status == nil || !slices.Equal(reply.Status.SplitDNSDomains, want) {
			t.Fatalf("status = %+v, want split DNS domains %q", reply.Status, want)
		}
		if reply.Status.SplitDNSDomains == nil {
			t.Fatal("empty routes must be sent explicitly as [], not null or omitted")
		}
	}
	prefs := (&ipn.Prefs{CorpDNS: true}).View()
	update(ipn.Notify{Prefs: &prefs, NetMap: &netmap.NetworkMap{DNS: tailcfg.DNSConfig{
		Routes: map[string][]*dnstype.Resolver{"internal.example.com": {{Addr: "192.168.1.53"}}},
	}}}, []string{"internal.example.com"})
	update(ipn.Notify{NetMap: &netmap.NetworkMap{DNS: tailcfg.DNSConfig{
		Routes: map[string][]*dnstype.Resolver{"new.example.com": nil},
	}}}, []string{"new.example.com"})
	disabled := (&ipn.Prefs{CorpDNS: false}).View()
	update(ipn.Notify{Prefs: &disabled}, nil)
	update(ipn.Notify{Prefs: &prefs}, []string{"new.example.com"})
	update(ipn.Notify{NetMap: &netmap.NetworkMap{}}, nil)
	for _, state := range []ipn.State{ipn.NoState, ipn.NeedsLogin} {
		update(ipn.Notify{NetMap: &netmap.NetworkMap{DNS: tailcfg.DNSConfig{
			Routes: map[string][]*dnstype.Resolver{"old-profile.example.com": nil},
		}}}, []string{"old-profile.example.com"})
		update(ipn.Notify{State: &state}, nil)
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
