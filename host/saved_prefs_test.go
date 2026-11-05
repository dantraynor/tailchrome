package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/ipn/store"
	"tailscale.com/ipn/store/mem"
	"tailscale.com/tsnet"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
	"tailscale.com/types/persist"
)

func writePrefsTestState(t *testing.T, st ipn.StateStore, entries map[ipn.StateKey]string) {
	t.Helper()
	for key, value := range entries {
		if err := st.WriteState(key, []byte(value)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestLoadSavedProfilePrefs(t *testing.T) {
	const known = `{"a":{"ID":"a","Key":"profile-a"},"b":{"ID":"b","Key":"profile-b"}}`
	for _, tc := range []struct {
		name, current, known, raw, pending, wantHostname string
		wantError                                        bool
	}{
		{name: "new browser profile"},
		{name: "selected account", current: "profile-b", known: known, raw: `{"Hostname":"selected"}`, wantHostname: "selected"},
		{name: "deleted account", current: "profile-deleted", known: known},
		{name: "missing account prefs", current: "profile-b", known: known},
		{name: "pending login", pending: `{"Hostname":"pending"}`, wantHostname: "pending"},
		{name: "account supersedes pending login", current: "profile-b", known: known, raw: `{"Hostname":"selected"}`, pending: `{"Hostname":"pending"}`, wantHostname: "selected"},
		{name: "ignore identity and TPM data", current: "profile-b", known: known, raw: `{"Hostname":"selected","Config":{"AttestationKey":{"platform":"specific"}}}`, wantHostname: "selected"},
		{name: "invalid known profiles", current: "profile-b", known: `{`, wantError: true},
		{name: "invalid account prefs", current: "profile-b", known: known, raw: `{"ShieldsUp":"invalid"}`, wantError: true},
		{name: "invalid pending prefs", pending: `null`, wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st := new(mem.Store)
			entries := map[ipn.StateKey]string{"profile-a": `{"Hostname":"other-account"}`}
			if tc.current != "" {
				entries[ipn.CurrentProfileStateKey] = tc.current
			}
			if tc.known != "" {
				entries[ipn.KnownProfilesStateKey] = tc.known
			}
			if tc.raw != "" {
				entries["profile-b"] = tc.raw
			}
			if tc.pending != "" {
				entries[pendingProfilePrefsKey] = tc.pending
			}
			writePrefsTestState(t, st, entries)
			got, err := loadSavedProfilePrefs(st)
			if (err != nil) != tc.wantError {
				t.Fatalf("error = %v, wantError = %v", err, tc.wantError)
			}
			if tc.wantError {
				return
			}
			if tc.wantHostname == "" {
				if got != nil {
					t.Fatal("restored preferences for an absent profile")
				}
				return
			}
			if got == nil || got.Hostname != tc.wantHostname || got.Persist != nil {
				t.Fatal("did not restore only the selected profile's preferences")
			}
		})
	}
}

type failingPrefsStore struct {
	ipn.StateStore
	readKey, writeKey ipn.StateKey
}

func (s failingPrefsStore) ReadState(key ipn.StateKey) ([]byte, error) {
	if key == s.readKey {
		return nil, errors.New("state read failed")
	}
	return s.StateStore.ReadState(key)
}

func (s failingPrefsStore) WriteState(key ipn.StateKey, data []byte) error {
	if key == s.writeKey {
		return errors.New("state write failed")
	}
	return s.StateStore.WriteState(key, data)
}

func TestLoadSavedProfilePrefsReportsReadErrors(t *testing.T) {
	for _, key := range []ipn.StateKey{ipn.CurrentProfileStateKey, ipn.KnownProfilesStateKey, "profile-a"} {
		t.Run(string(key), func(t *testing.T) {
			st := new(mem.Store)
			writePrefsTestState(t, st, map[ipn.StateKey]string{
				ipn.CurrentProfileStateKey: "profile-a",
				ipn.KnownProfilesStateKey:  `{"a":{"Key":"profile-a"}}`,
				"profile-a":                `{"ShieldsUp":true}`,
			})
			if _, err := loadSavedProfilePrefs(failingPrefsStore{StateStore: st, readKey: key}); err == nil {
				t.Fatal("state read error was treated as a new profile")
			}
		})
	}
}

func TestSavedDefaultControlURLOverridesEnvironment(t *testing.T) {
	t.Setenv("TS_CONTROL_URL", "https://environment.example.com")
	for _, raw := range []string{`""`, `"https://controlplane.tailscale.com"`, `"https://login.tailscale.com"`} {
		t.Run(raw, func(t *testing.T) {
			dir := t.TempDir()
			st, err := store.New(logger.Discard, filepath.Join(dir, "tailscaled.state"))
			if err != nil {
				t.Fatal(err)
			}
			writePrefsTestState(t, st, map[ipn.StateKey]string{pendingProfilePrefsKey: `{"ControlURL":` + raw + `}`})
			server, _, err := newProfileServer(dir)
			if err != nil {
				t.Fatal(err)
			}
			if server.ControlURL != ipn.DefaultControlURL {
				t.Fatalf("saved default changed to %q", server.ControlURL)
			}
		})
	}
}

func TestPendingProfilePrefsDoNotStoreIdentity(t *testing.T) {
	st := new(mem.Store)
	lc := &local.Client{}
	h := newHost(nil, nil)
	h.ts, h.lc = &tsnet.Server{Store: st}, lc
	writePrefsTestState(t, st, map[ipn.StateKey]string{ipn.CurrentProfileStateKey: "old-profile"})
	prefs := &ipn.Prefs{ControlURL: "https://headscale.example.com", ShieldsUp: true,
		Persist: &persist.Persist{PrivateNodeKey: key.NewNode(), NodeID: "old-node"}}
	if err := h.savePendingProfilePrefs(lc, prefs, true); err != nil {
		t.Fatal(err)
	}
	raw, err := st.ReadState(pendingProfilePrefsKey)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("old-node")) || bytes.Contains(raw, []byte("privkey:")) {
		t.Fatal("pending profile contains credentials or account identity")
	}
	saved, err := loadSavedProfilePrefs(st)
	if err != nil {
		t.Fatal(err)
	}
	if saved == nil || saved.Persist != nil || !saved.ShieldsUp || saved.ControlURL != prefs.ControlURL {
		t.Fatal("pending login preferences were not retained")
	}
	if prefs.Persist == nil {
		t.Fatal("saving preferences mutated the caller's identity")
	}
}

func TestInitRejectsCorruptSavedPrefs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tailscaled.state")
	st, err := store.New(logger.Discard, path)
	if err != nil {
		t.Fatal(err)
	}
	writePrefsTestState(t, st, map[ipn.StateKey]string{pendingProfilePrefsKey: `{"ShieldsUp":"invalid"}`})
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	h := newHost(nil, &output)
	h.stateDirForProfile = func(string) (string, error) { return dir, nil }
	h.handleRequest(Request{Cmd: "init", InitID: "test"})
	reply := decodeReply(t, &output)
	if reply.Init == nil || !strings.Contains(reply.Init.Error, "failed to load saved prefs") || h.ts != nil {
		t.Fatal("init started a node after failing to read saved preferences")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("failed init overwrote the saved state")
	}
}
