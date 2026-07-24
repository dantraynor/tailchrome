package main

import (
	"context"
	"fmt"

	"tailscale.com/ipn"
	"tailscale.com/tailcfg"
)

// handleSetExitNode sets the exit node to the given node ID.
// An empty nodeID clears the exit node.
func (h *Host) handleSetExitNode(nodeID string) {
	lc := h.localClient("set-exit-node")
	if lc == nil {
		return
	}

	ctx := context.Background()
	_, err := lc.EditPrefs(ctx, &ipn.MaskedPrefs{
		Prefs: ipn.Prefs{
			ExitNodeID: tailcfg.StableNodeID(nodeID),
		},
		ExitNodeIDSet: true,
	})
	if err != nil {
		h.sendError("set-exit-node", fmt.Sprintf("failed to set exit node: %v", err))
		return
	}

	// Send updated status after changing exit node.
	h.handleGetStatus()
}

// handleSuggestExitNode calls the local client's SuggestExitNode API and
// sends the suggestion to the extension.
func (h *Host) handleSuggestExitNode() {
	lc := h.localClient("suggest-exit-node")
	if lc == nil {
		return
	}

	ctx := context.Background()
	suggestion, err := lc.SuggestExitNode(ctx)
	if err != nil {
		h.sendError("suggest-exit-node", fmt.Sprintf("failed to suggest exit node: %v", err))
		return
	}

	reply := &ExitNodeSuggestion{
		ID:       string(suggestion.ID),
		Hostname: suggestion.Name,
	}

	if suggestion.Location.Valid() {
		loc := suggestion.Location
		reply.Location = &LocationInfo{
			City:        loc.City(),
			CityCode:    loc.CityCode(),
			Country:     loc.Country(),
			CountryCode: loc.CountryCode(),
			Latitude:    loc.Latitude(),
			Longitude:   loc.Longitude(),
			Priority:    loc.Priority(),
		}
	}

	h.send(Reply{
		Cmd:                "exitNodeSuggestion",
		ExitNodeSuggestion: reply,
	})
}
