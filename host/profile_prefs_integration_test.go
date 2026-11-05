package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/net/netns"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/logger"
)

func newPrefsTestControl(t *testing.T, requireAuth bool) (*testcontrol.Server, func()) {
	t.Helper()
	control := &testcontrol.Server{DERPMap: splitDNSTestDERP(t), RequireAuth: requireAuth, Logf: logger.Discard}
	server := httptest.NewUnstartedServer(control)
	control.HTTPTestServer = server
	var connections sync.Map
	server.Config.ConnState = func(conn net.Conn, state http.ConnState) {
		if state == http.StateNew {
			connections.Store(conn, struct{}{})
		}
		if state == http.StateClosed {
			connections.Delete(conn)
		}
	}
	server.Start()
	stop := func() {
		server.Listener.Close()
		// HTTP shutdown alone leaves the hijacked control connections alive.
		connections.Range(func(conn, _ any) bool { conn.(net.Conn).Close(); return true })
		server.Close()
	}
	t.Cleanup(stop)
	return control, stop
}

func prefsTestRequest(t *testing.T, h *Host, request Request) []Reply {
	t.Helper()
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	var input bytes.Buffer
	appendNativeMessage(t, &input, payload)
	h.stdin = &input
	h.readMessages()
	h.mu.Lock()
	replies := decodeAllReplies(t, h.stdout.(*bytes.Buffer))
	h.mu.Unlock()
	for _, reply := range replies {
		if reply.Error != nil {
			t.Fatalf("%s failed: %s", request.Cmd, reply.Error.Message)
		}
		if reply.Init != nil && reply.Init.Error != "" {
			t.Fatalf("init failed: %s", reply.Init.Error)
		}
	}
	return replies
}

func initPrefsTestHost(t *testing.T, root, id string, wantRunning bool) *Host {
	t.Helper()
	h := newHost(nil, new(bytes.Buffer))
	h.stateDirForProfile = func(id string) (string, error) { return filepath.Join(root, id), nil }
	t.Cleanup(h.shutdownSession)
	replies := prefsTestRequest(t, h, Request{Cmd: "init", InitID: id, WantRunning: &wantRunning})
	if !slices.ContainsFunc(replies, func(r Reply) bool { return r.Init != nil }) || h.ts == nil {
		t.Fatal("init did not acknowledge an active session")
	}
	return h
}

func TestInitRestoresSavedProfilePrefs(t *testing.T) {
	if testing.Short() {
		t.Skip("starts an embedded tailnet node")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })
	control, _ := newPrefsTestControl(t, false)
	controlURL := control.HTTPTestServer.URL
	t.Setenv("TS_CONTROL_URL", controlURL)
	root := t.TempDir()
	first := initPrefsTestHost(t, root, "browser-a", true)
	before, err := first.ts.Up(ctx)
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := first.lc.GetPrefs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !fresh.RouteAll {
		t.Fatal("new browser profile does not accept subnet routes")
	}
	prefsTestRequest(t, first, Request{Cmd: "set-prefs", Prefs: json.RawMessage(`{
		"hostname":"work-browser", "routeAll":false, "corpDNS":false,
		"shieldsUp":true, "exitNodeAllowLANAccess":true,
		"advertiseRoutes":["10.9.0.0/24","fd00:9::/64"], "advertiseExitNode":true
	}`)})
	saved, err := first.lc.GetPrefs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	first.shutdownSession()

	// A saved server must win over the environment before the first connection.
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("restarted profile contacted the fallback coordination server")
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(fallback.Close)
	t.Setenv("TS_CONTROL_URL", fallback.URL)
	for _, wantRunning := range []bool{true, false} {
		restarted := initPrefsTestHost(t, root, "browser-a", wantRunning)
		if !wantRunning {
			select {
			case <-restarted.correctionDone:
			case <-ctx.Done():
				t.Fatal("startup did not apply wantRunning=false")
			}
		}
		got, err := restarted.lc.GetPrefs(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if got.ControlURL != controlURL || got.Hostname != "work-browser" || got.RouteAll || got.CorpDNS || !got.ShieldsUp || !got.ExitNodeAllowLANAccess || got.WantRunning != wantRunning {
			t.Fatalf("startup did not restore saved preferences: %s", got.Pretty())
		}
		if !slices.Equal(got.AdvertiseRoutes, saved.AdvertiseRoutes) || !got.AdvertisesExitNode() {
			t.Fatalf("advertised routes after restart = %v, want %v", got.AdvertiseRoutes, saved.AdvertiseRoutes)
		}
		if wantRunning {
			after, err := restarted.ts.Up(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if after.Self.PublicKey != before.Self.PublicKey {
				t.Fatal("restart changed the profile's node identity")
			}
		} else {
			prefsTestRequest(t, restarted, Request{Cmd: "set-prefs", Prefs: json.RawMessage(`{"hostname":""}`)})
		}
		restarted.shutdownSession()
	}
	cleared := initPrefsTestHost(t, root, "browser-a", false)
	prefs, err := cleared.lc.GetPrefs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if prefs.Hostname != "" {
		t.Fatal("restart replaced an explicitly cleared hostname")
	}
}

func TestControlURLSwitchPreservesProfilesWithoutRemoteLogout(t *testing.T) {
	if testing.Short() {
		t.Skip("starts embedded tailnet nodes")
	}
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })
	for _, offline := range []bool{false, true} {
		name := "previous-server-online"
		if offline {
			name = "previous-server-offline"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
			defer cancel()
			previous, stopPrevious := newPrefsTestControl(t, false)
			next, _ := newPrefsTestControl(t, true)
			t.Setenv("TS_CONTROL_URL", previous.HTTPTestServer.URL)
			root := t.TempDir()
			h := initPrefsTestHost(t, root, "browser", true)
			before, err := h.ts.Up(ctx)
			if err != nil {
				t.Fatal(err)
			}
			prefsTestRequest(t, h, Request{Cmd: "set-prefs", Prefs: json.RawMessage(`{"hostname":"previous-browser","shieldsUp":true}`)})
			oldProfile, _, err := h.lc.ProfileStatus(ctx)
			if err != nil || oldProfile.ID == "" {
				t.Fatalf("initial profile not saved: %v", err)
			}
			if offline {
				stopPrevious()
			}
			payload, err := json.Marshal(map[string]string{"controlURL": next.HTTPTestServer.URL})
			if err != nil {
				t.Fatal(err)
			}
			started := time.Now()
			prefsTestRequest(t, h, Request{Cmd: "set-prefs", Prefs: payload})
			if time.Since(started) > 5*time.Second {
				t.Fatal("changing servers waited for the old server")
			}
			current, all, err := h.lc.ProfileStatus(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if current.ID != "" || len(all) != 1 || all[0].ID != oldProfile.ID || all[0].ControlURL != oldProfile.ControlURL {
				t.Fatal("switch did not preserve the old account and select a fresh login")
			}
			prefs, err := h.lc.GetPrefs(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if prefs.ControlURL != next.HTTPTestServer.URL || (prefs.Persist != nil && prefs.Persist.NodeID != "") || prefs.ExitNodeID != "" || prefs.ExitNodeIP.IsValid() {
				t.Fatal("new server inherited the old account or exit node")
			}
			// Edits made before the new login must also survive a helper restart.
			prefsTestRequest(t, h, Request{Cmd: "set-prefs", Prefs: json.RawMessage(`{"hostname":"pending-browser","routeAll":false,"corpDNS":false}`)})
			h.shutdownSession()
			h = initPrefsTestHost(t, root, "browser", true)
			prefs, err = h.lc.GetPrefs(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if prefs.ControlURL != next.HTTPTestServer.URL || prefs.Hostname != "pending-browser" || prefs.RouteAll || prefs.CorpDNS || !prefs.ShieldsUp {
				t.Fatal("restart lost the pending server or preferences")
			}
			loginURL := prefsTestLoginURL(t, ctx, h.lc)
			if !next.CompleteAuth(loginURL) {
				t.Fatal("new server did not issue a fresh login")
			}
			after, err := h.ts.Up(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if after.Self.PublicKey == before.Self.PublicKey {
				t.Fatal("control server change reused the old node identity")
			}

			// The registered new account supersedes pending settings on restart.
			h.shutdownSession()
			h = initPrefsTestHost(t, root, "browser", true)
			afterRestart, err := h.ts.Up(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if afterRestart.Self.PublicKey != after.Self.PublicKey {
				t.Fatal("pending preferences discarded the completed login")
			}

			// Returning to the previous account restores its own settings.
			prefsTestRequest(t, h, Request{Cmd: "switch-profile", ProfileID: string(oldProfile.ID)})
			prefs, err = h.lc.GetPrefs(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if prefs.ControlURL != previous.HTTPTestServer.URL || prefs.Hostname != "previous-browser" || !prefs.ShieldsUp {
				t.Fatal("changing servers modified the previous account")
			}
			if !offline {
				restored, err := h.ts.Up(ctx)
				if err != nil {
					t.Fatal(err)
				}
				if restored.Self.PublicKey != before.Self.PublicKey {
					t.Fatal("returning to the previous account required a new identity")
				}
			}
		})
	}
}

func prefsTestLoginURL(t *testing.T, ctx context.Context, lc *local.Client) string {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		status, err := lc.StatusWithoutPeers(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if status.AuthURL != "" {
			return status.AuthURL
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("timed out waiting for the new server's login URL")
		}
	}
}
