package main

import (
	"context"
	"fmt"

	"tailscale.com/ipn"
)

// handleListProfiles fetches the current profile and all profiles, and sends
// them to the extension.
func (h *Host) handleListProfiles() {
	if err := h.requireInit("list-profiles"); err != nil {
		return
	}

	ctx := context.Background()
	current, all, err := h.lc.ProfileStatus(ctx)
	if err != nil {
		h.sendError("list-profiles", fmt.Sprintf("failed to list profiles: %v", err))
		return
	}

	profiles := make([]ProfileInfo, len(all))
	for i, p := range all {
		profiles[i] = loginProfileToProfileInfo(p)
	}

	h.send(Reply{
		Cmd: "profiles",
		Profiles: &ProfilesReply{
			Current:  loginProfileToProfileInfo(current),
			Profiles: profiles,
		},
	})
}

// handleSwitchProfile switches to the given profile ID.
func (h *Host) handleSwitchProfile(profileID string) {
	if err := h.requireInit("switch-profile"); err != nil {
		return
	}

	if profileID == "" {
		h.sendError("switch-profile", "profileID is required")
		return
	}

	h.cancelStartupCorrection()

	ctx := context.Background()
	if err := h.lc.SwitchProfile(ctx, ipn.ProfileID(profileID)); err != nil {
		h.sendError("switch-profile", fmt.Sprintf("failed to switch profile: %v", err))
		return
	}

	// Send updated profiles after switching.
	h.handleListProfiles()
}

// handleNewProfile creates a new empty profile and switches to it.
func (h *Host) handleNewProfile() {
	if err := h.requireInit("new-profile"); err != nil {
		return
	}

	h.cancelStartupCorrection()

	ctx := context.Background()
	if err := h.lc.SwitchToEmptyProfile(ctx); err != nil {
		h.sendError("new-profile", fmt.Sprintf("failed to create new profile: %v", err))
		return
	}

	// Send updated profiles after creating.
	h.handleListProfiles()
}

// handleDeleteProfile deletes the profile with the given ID.
func (h *Host) handleDeleteProfile(profileID string) {
	if err := h.requireInit("delete-profile"); err != nil {
		return
	}

	if profileID == "" {
		h.sendError("delete-profile", "profileID is required")
		return
	}

	h.cancelStartupCorrection()

	ctx := context.Background()
	if err := h.lc.DeleteProfile(ctx, ipn.ProfileID(profileID)); err != nil {
		h.sendError("delete-profile", fmt.Sprintf("failed to delete profile: %v", err))
		return
	}

	// Send updated profiles after deleting.
	h.handleListProfiles()
}

// loginProfileToProfileInfo converts an ipn.LoginProfile to our ProfileInfo type.
func loginProfileToProfileInfo(lp ipn.LoginProfile) ProfileInfo {
	return ProfileInfo{
		ID:   string(lp.ID),
		Name: lp.Name,
	}
}
