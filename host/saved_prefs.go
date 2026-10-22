package main

import (
	"encoding/json"
	"errors"
	"fmt"

	"tailscale.com/ipn"
)

// loadSavedProfilePrefs returns the prefs saved for the profile the node will
// start on, or nil when that profile has none yet. tsnet.Server.Start replaces
// the stored prefs with its defaults on every launch, keeping only the node
// identity, so they must be read before Start and reapplied after it (#153).
//
// The starting profile is the one named by the current-profile key, provided
// it is still a known profile; LocalBackend falls back to a new, empty profile
// otherwise, and so does this function.
func loadSavedProfilePrefs(st ipn.StateStore) (*ipn.Prefs, error) {
	current, err := st.ReadState(ipn.CurrentProfileStateKey)
	if errors.Is(err, ipn.ErrStateNotExist) || len(current) == 0 {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading current profile: %w", err)
	}
	profileKey := ipn.StateKey(current)

	knownRaw, err := st.ReadState(ipn.KnownProfilesStateKey)
	if errors.Is(err, ipn.ErrStateNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading known profiles: %w", err)
	}
	var known map[ipn.ProfileID]struct {
		Key ipn.StateKey
	}
	if err := json.Unmarshal(knownRaw, &known); err != nil {
		return nil, fmt.Errorf("parsing known profiles: %w", err)
	}
	found := false
	for _, profile := range known {
		if profile.Key == profileKey {
			found = true
			break
		}
	}
	if !found {
		return nil, nil
	}

	raw, err := st.ReadState(profileKey)
	if errors.Is(err, ipn.ErrStateNotExist) || len(raw) == 0 {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading saved prefs: %w", err)
	}
	// Drop the node identity ("Config"). tsnet keeps it on its own, and its
	// hardware attestation key cannot be decoded without the platform TPM.
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, fmt.Errorf("parsing saved prefs: %w", err)
	}
	delete(fields, "Config")
	stripped, err := json.Marshal(fields)
	if err != nil {
		return nil, err
	}
	prefs := ipn.NewPrefs()
	if err := json.Unmarshal(stripped, prefs); err != nil {
		return nil, fmt.Errorf("parsing saved prefs: %w", err)
	}
	return prefs, nil
}

// savedHostname returns the hostname tsnet should start with.
func savedHostname(saved *ipn.Prefs) string {
	if saved != nil && saved.Hostname != "" {
		return saved.Hostname
	}
	return "browser-ext"
}

// savedControlURL returns a custom coordination server saved for the profile,
// or "" to let tsnet choose (TS_CONTROL_URL or the Tailscale default). It must
// reach tsnet before Start: once started on the wrong server, the node would
// present its identity there.
func savedControlURL(saved *ipn.Prefs) string {
	if saved == nil {
		return ""
	}
	return controlURLForPrefs(saved.ControlURL)
}

// restoredStartupPrefs reapplies the settings the extension can change that
// tsnet.Server.Start reset. Hostname and ControlURL go to tsnet directly,
// WantRunning follows the init request, and the extension restores its
// selected exit node itself. A profile with no saved prefs gets the defaults
// from startupPrefs.
func restoredStartupPrefs(saved *ipn.Prefs) *ipn.MaskedPrefs {
	if saved == nil {
		return startupPrefs()
	}
	return &ipn.MaskedPrefs{
		Prefs: ipn.Prefs{
			RouteAll:               saved.RouteAll,
			ExitNodeAllowLANAccess: saved.ExitNodeAllowLANAccess,
			CorpDNS:                saved.CorpDNS,
			ShieldsUp:              saved.ShieldsUp,
			RunSSH:                 saved.RunSSH,
			AdvertiseRoutes:        saved.AdvertiseRoutes,
		},
		RouteAllSet:               true,
		ExitNodeAllowLANAccessSet: true,
		CorpDNSSet:                true,
		ShieldsUpSet:              true,
		RunSSHSet:                 true,
		AdvertiseRoutesSet:        true,
	}
}
