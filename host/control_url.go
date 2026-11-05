package main

import (
	"context"
	"fmt"
	"net/netip"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
)

// switchControlURL starts a fresh local profile without requiring the previous
// control server to acknowledge logout. Keep the previous profile unchanged so
// a failed switch can restore its identity as well as its preferences.
func (h *Host) switchControlURL(lc *local.Client, partial partialPrefsUpdate) error {
	finish := h.beginProxyProfileChange(lc)
	defer finish()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Re-read after draining web mutations and stopping startup correction.
	currentPrefs, err := lc.GetPrefs(ctx)
	if err != nil {
		return fmt.Errorf("failed to get current prefs: %w", err)
	}
	mp, changed, err := maskedPrefsForUpdate(partial, currentPrefs)
	if err != nil {
		return err
	}
	if !changed {
		updated, err := lc.EditPrefs(ctx, mp)
		if err != nil {
			return fmt.Errorf("failed to set prefs: %w", err)
		}
		return h.savePendingProfilePrefs(lc, updated, false)
	}
	current, _, err := lc.ProfileStatus(ctx)
	if err != nil {
		return fmt.Errorf("failed to read current profile: %w", err)
	}
	updated := currentPrefs.Clone()
	updated.ApplyEdits(mp)
	updated.Persist = nil
	updated.ProfileName = ""
	updated.LoggedOut = false
	updated.ExitNodeID = ""
	updated.ExitNodeIP = netip.Addr{}
	updated.AutoExitNode = ""
	updated.InternalExitNodePrior = ""
	if err := lc.CheckPrefs(ctx, updated); err != nil {
		return fmt.Errorf("failed to set prefs: %w", err)
	}

	rollback := func(cause error) error {
		rollbackCtx, rollbackCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer rollbackCancel()
		var restoreErr error
		if current.ID != "" {
			restoreErr = lc.SwitchProfile(rollbackCtx, current.ID)
		} else {
			restoreErr = lc.SwitchToEmptyProfile(rollbackCtx)
			if restoreErr == nil {
				restoreErr = h.savePendingProfilePrefs(lc, currentPrefs, true)
			}
			if restoreErr == nil {
				restoreErr = lc.Start(rollbackCtx, ipn.Options{UpdatePrefs: currentPrefs})
			}
		}
		if restoreErr != nil {
			h.clearCachedStatus(nil)
			return fmt.Errorf("failed to change control server: %w; also failed to restore previous profile: %v", cause, restoreErr)
		}
		h.clearCachedStatus(currentPrefs)
		return fmt.Errorf("failed to change control server: %w; restored previous profile", cause)
	}
	if err := lc.SwitchToEmptyProfile(ctx); err != nil {
		return rollback(err)
	}
	if err := h.savePendingProfilePrefs(lc, updated, true); err != nil {
		return rollback(fmt.Errorf("failed to save pending profile: %w", err))
	}
	if err := lc.Start(ctx, ipn.Options{UpdatePrefs: updated}); err != nil {
		return rollback(err)
	}
	h.clearCachedStatus(updated)
	return nil
}
