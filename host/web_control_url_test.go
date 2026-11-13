package main

import (
	"bytes"
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
	"tailscale.com/client/web"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/ipn/store/mem"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/types/logger"
	"tailscale.com/types/persist"
)

func TestControlURLChangeInvalidatesWebSession(t *testing.T) {
	const oldURL, newURL = "https://old.example.com", "https://new.example.com"
	for _, tc := range []struct {
		name, currentURL, requestedURL, failAt, wantError string
		changesSession                                    bool
		anonymous                                         bool
		wantMutations                                     []string
	}{
		{name: "new server", currentURL: oldURL, requestedURL: newURL, changesSession: true,
			wantMutations: []string{"new-profile", "start " + newURL}},
		{name: "same server", currentURL: oldURL, requestedURL: oldURL,
			wantMutations: []string{"edit"}},
		{name: "equivalent server URL", currentURL: oldURL, requestedURL: "https://OLD.example.com:443/",
			wantMutations: []string{"edit"}},
		{name: "default server alias", currentURL: "", requestedURL: "https://login.tailscale.com",
			wantMutations: []string{"edit"}},
		{name: "edit fails", currentURL: oldURL, requestedURL: oldURL, failAt: "edit",
			wantMutations: []string{"edit"}, wantError: "failed to set prefs"},
		{name: "invalid prefs", currentURL: oldURL, requestedURL: newURL, changesSession: true, failAt: "check",
			wantError: "failed to set prefs"},
		{name: "profile lookup fails", currentURL: oldURL, requestedURL: newURL, changesSession: true, failAt: "profiles",
			wantError: "failed to read current profile"},
		{name: "new profile fails", currentURL: oldURL, requestedURL: newURL, changesSession: true, failAt: "new-profile",
			wantMutations: []string{"new-profile", "switch old"}, wantError: "restored previous profile"},
		{name: "saving pending prefs fails", currentURL: oldURL, requestedURL: newURL, changesSession: true, failAt: "save",
			wantMutations: []string{"new-profile", "switch old"}, wantError: "failed to save pending profile"},
		{name: "restart fails", currentURL: oldURL, requestedURL: newURL, changesSession: true, failAt: "restart",
			wantMutations: []string{"new-profile", "start " + newURL, "switch old"}, wantError: "restored previous profile"},
		{name: "restart fails before first login", currentURL: oldURL, requestedURL: newURL, changesSession: true, anonymous: true, failAt: "restart",
			wantMutations: []string{"new-profile", "start " + newURL, "new-profile", "start " + oldURL}, wantError: "restored previous profile"},
		{name: "rollback also fails", currentURL: oldURL, requestedURL: newURL, changesSession: true, failAt: "rollback",
			wantMutations: []string{"new-profile", "start " + newURL, "switch old"}, wantError: "also failed to restore previous profile"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var output bytes.Buffer
			h := newHost(nil, &output)
			watchCtx, watchCancel := context.WithCancel(t.Context())
			h.watchCancel = watchCancel
			mutations := make(chan string, 4)
			watcherStarted := make(chan struct{}, 1)
			currentPrefs := &ipn.Prefs{
				ControlURL: tc.currentURL, ProfileName: "work", Hostname: "work-browser", ShieldsUp: true,
				ExitNodeID: "old-exit", ExitNodeIP: netip.MustParseAddr("100.64.0.1"),
				AutoExitNode: "any", InternalExitNodePrior: "old-exit", Persist: &persist.Persist{NodeID: "old-node"},
			}
			checkSessionBeforeMutation := func(mutation string) {
				t.Helper()
				h.sessionMu.RLock()
				generation := h.sessionGeneration
				h.sessionMu.RUnlock()
				h.webMu.Lock()
				cacheCleared := h.webCache == nil
				h.webMu.Unlock()
				wantGeneration := uint64(7)
				if tc.changesSession {
					wantGeneration++
				}
				if cacheCleared != tc.changesSession || generation != wantGeneration {
					t.Errorf("before %s: cleared cache = %v, generation = %d; want %v, %d", mutation, cacheCleared, generation, tc.changesSession, wantGeneration)
				}
				request := httptest.NewRequest(http.MethodGet, "http://100.100.100.100/api/auth", nil)
				_, done, admitted := h.beginWebRequest(httptest.NewRecorder(), request)
				if admitted {
					done()
				}
				if admitted == tc.changesSession {
					t.Errorf("before %s: web admission = %v, want %v", mutation, admitted, !tc.changesSession)
				}
				mutations <- mutation
			}
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/localapi/v0/prefs":
					if r.Method == http.MethodGet {
						json.NewEncoder(w).Encode(currentPrefs)
						return
					}
					checkSessionBeforeMutation("edit")
					if tc.failAt == "edit" {
						http.Error(w, "edit failed", http.StatusInternalServerError)
						return
					}
					var prefs ipn.MaskedPrefs
					if err := json.NewDecoder(r.Body).Decode(&prefs); err != nil {
						t.Error(err)
					}
					json.NewEncoder(w).Encode(&prefs.Prefs)
				case "/localapi/v0/check-prefs":
					var prefs ipn.Prefs
					if err := json.NewDecoder(r.Body).Decode(&prefs); err != nil {
						t.Error(err)
					}
					if prefs.Persist != nil || prefs.ProfileName != "" || prefs.ExitNodeID != "" || prefs.ExitNodeIP.IsValid() || prefs.AutoExitNode != "" || prefs.InternalExitNodePrior != "" {
						t.Error("server switch carried identity or exit-node settings to the new profile")
					}
					if prefs.ControlURL != newURL || prefs.Hostname != "work-browser" || !prefs.ShieldsUp {
						t.Error("server switch lost device preferences")
					}
					if tc.failAt == "check" {
						http.Error(w, "invalid prefs", http.StatusBadRequest)
					}
				case "/localapi/v0/profiles/current":
					if tc.failAt == "profiles" {
						http.Error(w, "profile lookup failed", http.StatusInternalServerError)
						return
					}
					profile := ipn.LoginProfile{ID: "old", Name: "work"}
					if tc.anonymous {
						profile = ipn.LoginProfile{}
					}
					json.NewEncoder(w).Encode(profile)
				case "/localapi/v0/profiles/":
					if r.Method == http.MethodGet {
						json.NewEncoder(w).Encode([]ipn.LoginProfile{{ID: "old", Name: "work"}})
						return
					}
					checkSessionBeforeMutation("new-profile")
					if tc.failAt == "new-profile" {
						http.Error(w, "new profile failed", http.StatusInternalServerError)
						return
					}
					w.WriteHeader(http.StatusCreated)
				case "/localapi/v0/profiles/old":
					checkSessionBeforeMutation("switch old")
					if tc.failAt == "rollback" {
						http.Error(w, "profile restore failed", http.StatusInternalServerError)
						return
					}
					w.WriteHeader(http.StatusNoContent)
				case "/localapi/v0/logout":
					t.Error("changing servers must not depend on remote logout")
					http.Error(w, "old server unreachable", http.StatusGatewayTimeout)
				case "/localapi/v0/start":
					var opts ipn.Options
					if err := json.NewDecoder(r.Body).Decode(&opts); err != nil || opts.UpdatePrefs == nil {
						t.Errorf("invalid start options: %+v, %v", opts, err)
						http.Error(w, "invalid options", http.StatusBadRequest)
						return
					}
					checkSessionBeforeMutation("start " + opts.UpdatePrefs.ControlURL)
					if tc.failAt == "rollback" || (tc.failAt == "restart" && opts.UpdatePrefs.ControlURL == newURL) {
						http.Error(w, "start failed", http.StatusInternalServerError)
						return
					}
					w.WriteHeader(http.StatusNoContent)
				case "/localapi/v0/status":
					json.NewEncoder(w).Encode(&ipnstate.Status{BackendState: "NeedsLogin"})
				case "/localapi/v0/watch-ipn-bus":
					watcherStarted <- struct{}{}
					w.WriteHeader(http.StatusOK)
					w.(http.Flusher).Flush()
					<-r.Context().Done()
				default:
					// web.NewServer reports an initialization metric asynchronously.
					w.WriteHeader(http.StatusNoContent)
				}
			}))
			t.Cleanup(api.Close)
			lc := &local.Client{OmitAuth: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, network, api.Listener.Addr().String())
			}}
			server, err := web.NewServer(web.ServerOpts{
				Mode: web.ManageServerMode, LocalClient: lc, Logf: logger.Discard,
				NewAuthURL: func(context.Context, tailcfg.NodeID) (*tailcfg.WebClientAuthResponse, error) {
					return &tailcfg.WebClientAuthResponse{}, nil
				},
				WaitAuthURL: func(context.Context, string, tailcfg.NodeID) (*tailcfg.WebClientAuthResponse, error) {
					return &tailcfg.WebClientAuthResponse{Complete: true}, nil
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			h.lc = lc
			if tc.failAt == "save" {
				h.ts = &tsnet.Server{Store: failingPrefsStore{StateStore: new(mem.Store), writeKey: pendingProfilePrefsKey}}
			}
			h.sessionGeneration = 7
			cache := &webServerCache{client: lc, generation: 7, server: server}
			h.webCache = cache
			t.Cleanup(func() {
				h.sessionMu.Lock()
				if h.watchCancel != nil {
					h.watchCancel()
				}
				h.sessionMu.Unlock()
				h.clearWebServer()
			})

			prefs, err := json.Marshal(map[string]string{"controlURL": tc.requestedURL})
			if err != nil {
				t.Fatal(err)
			}
			h.handleSetPrefs(Request{Prefs: prefs})

			close(mutations)
			var gotMutations []string
			for mutation := range mutations {
				gotMutations = append(gotMutations, mutation)
			}
			if !slices.Equal(gotMutations, tc.wantMutations) {
				t.Fatalf("mutations = %q, want %q", gotMutations, tc.wantMutations)
			}
			if tc.changesSession {
				if h.webCache != nil || h.sessionGeneration != 8 || watchCtx.Err() == nil {
					t.Fatal("control server transition restored the previous web session or watcher")
				}
				select {
				case <-watcherStarted:
				case <-time.After(2 * time.Second):
					t.Fatal("IPN watcher was not restarted")
				}
			} else if h.webCache != cache || h.sessionGeneration != 7 || watchCtx.Err() != nil {
				t.Fatal("equivalent control URL invalidated the active web session")
			}
			request := httptest.NewRequest(http.MethodGet, "http://100.100.100.100/api/auth", nil)
			_, done, admitted := h.beginWebRequest(httptest.NewRecorder(), request)
			if !admitted {
				t.Fatal("web admission remained blocked after preference update")
			}
			done()
			var gotError string
			for _, reply := range decodeAllReplies(t, &output) {
				if reply.Error != nil {
					gotError += reply.Error.Message
				}
			}
			if (gotError != "") != (tc.wantError != "") || !strings.Contains(gotError, tc.wantError) {
				t.Fatalf("error = %q, want %q", gotError, tc.wantError)
			}
		})
	}
}
