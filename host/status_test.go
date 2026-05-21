package main

import (
	"testing"

	"tailscale.com/ipn/ipnstate"
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
