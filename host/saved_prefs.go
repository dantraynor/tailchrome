package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"path/filepath"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/ipn/store"
	"tailscale.com/tsnet"
)

// Tailscale saves a profile's preferences only after its first successful login.
// Keep settings for the pending login in the same state store, without keys or
// account identity. A persisted current profile always takes precedence.
const pendingProfilePrefsKey ipn.StateKey = "tailchrome-pending-prefs"

// loadSavedProfilePrefs reads the active profile before tsnet.Start replaces
// its preferences. tsnet uses CurrentProfileStateKey on every platform, including
// Windows (LocalBackendStartKeyOSNeutral).
func loadSavedProfilePrefs(st ipn.StateStore) (*ipn.Prefs, error) {
	current, err := st.ReadState(ipn.CurrentProfileStateKey)
	if err != nil && !errors.Is(err, ipn.ErrStateNotExist) {
		return nil, fmt.Errorf("reading current profile: %w", err)
	}
	key := pendingProfilePrefsKey
	if len(current) != 0 {
		key = ipn.StateKey(current)
		raw, err := st.ReadState(ipn.KnownProfilesStateKey)
		if errors.Is(err, ipn.ErrStateNotExist) {
			return nil, nil
		}
		if err != nil {
			return nil, fmt.Errorf("reading known profiles: %w", err)
		}
		var profiles map[ipn.ProfileID]ipn.LoginProfile
		if err := json.Unmarshal(raw, &profiles); err != nil {
			return nil, fmt.Errorf("parsing known profiles: %w", err)
		}
		found := false
		for _, profile := range profiles {
			if profile.Key == key {
				found = true
				break
			}
		}
		if !found {
			// Match Tailscale's fallback for a deleted or unknown profile.
			return nil, nil
		}
	}
	raw, err := st.ReadState(key)
	if errors.Is(err, ipn.ErrStateNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading saved prefs: %w", err)
	}
	if len(raw) == 0 {
		return nil, nil
	}
	// Config holds the node identity and may contain a platform-specific TPM
	// key. Let Tailscale decode it; only restore user preferences here.
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, fmt.Errorf("parsing saved prefs: %w", err)
	}
	if fields == nil {
		return nil, fmt.Errorf("saved prefs must be a JSON object")
	}
	delete(fields, "Config")
	raw, err = json.Marshal(fields)
	if err != nil {
		return nil, err
	}
	prefs := ipn.NewPrefs()
	if err := json.Unmarshal(raw, prefs); err != nil {
		return nil, fmt.Errorf("parsing saved prefs: %w", err)
	}
	return prefs, nil
}

func newProfileServer(stateDir string) (*tsnet.Server, *ipn.Prefs, error) {
	st, err := store.New(log.Printf, filepath.Join(stateDir, "tailscaled.state"))
	if err != nil {
		return nil, nil, fmt.Errorf("failed to open state: %w", err)
	}
	saved, err := loadSavedProfilePrefs(st)
	if err != nil {
		// Do not start on a different server or overwrite unreadable settings.
		return nil, nil, fmt.Errorf("failed to load saved prefs: %w", err)
	}
	server := &tsnet.Server{
		Dir: stateDir, Store: st, Hostname: "browser-ext",
		RunWebClient: true, Logf: log.Printf,
	}
	if saved != nil {
		if saved.Hostname != "" {
			server.Hostname = saved.Hostname
		}
		server.ControlURL = saved.ControlURL
		if isDefaultControlURL(server.ControlURL) {
			// An explicitly saved default must not fall back to TS_CONTROL_URL.
			server.ControlURL = ipn.DefaultControlURL
		}
		server.AdvertiseTags = saved.AdvertiseTags
	}
	return server, saved, nil
}

func restoredStartupPrefs(saved *ipn.Prefs) *ipn.MaskedPrefs {
	if saved == nil {
		return startupPrefs()
	}
	// ControlURL and Hostname reach tsnet before it connects. The extension
	// supplies WantRunning and restores the exit-node selection for the account.
	return &ipn.MaskedPrefs{
		Prefs: ipn.Prefs{
			RouteAll: saved.RouteAll, CorpDNS: saved.CorpDNS,
			ShieldsUp: saved.ShieldsUp, RunSSH: saved.RunSSH,
			Hostname:               saved.Hostname,
			ExitNodeAllowLANAccess: saved.ExitNodeAllowLANAccess,
			AdvertiseRoutes:        saved.AdvertiseRoutes,
		},
		RouteAllSet: true, CorpDNSSet: true, ShieldsUpSet: true, RunSSHSet: true, HostnameSet: true,
		ExitNodeAllowLANAccessSet: true, AdvertiseRoutesSet: true,
	}
}

// savePendingProfilePrefs complements Tailscale's persistence for a profile
// that has not logged in yet. A new login or a switch to an existing account
// writes CurrentProfileStateKey and supersedes this pending configuration.
// reset is used only after switching to an empty profile, before starting login.
func (h *Host) savePendingProfilePrefs(lc *local.Client, prefs *ipn.Prefs, reset bool) error {
	server, currentClient, _ := h.sessionSnapshot()
	if server == nil || server.Store == nil || currentClient != lc {
		return nil
	}
	st := server.Store
	if !reset {
		current, err := st.ReadState(ipn.CurrentProfileStateKey)
		if err != nil && !errors.Is(err, ipn.ErrStateNotExist) {
			return err
		}
		if len(current) != 0 {
			return nil
		}
	}
	var data []byte
	if prefs != nil {
		saved := prefs.Clone()
		saved.Persist = nil
		var err error
		data, err = json.Marshal(saved)
		if err != nil {
			return err
		}
	}
	if err := st.WriteState(pendingProfilePrefsKey, data); err != nil {
		return err
	}
	if reset {
		// SwitchToEmptyProfile leaves the previous startup profile selected on
		// disk. Clear only that pointer; retain the account for switching back.
		return st.WriteState(ipn.CurrentProfileStateKey, nil)
	}
	return nil
}
