package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
)

const (
	authKeyLoginCmd = "login-auth-key"

	// maxAuthKeyLen bounds the key accepted over native messaging. Tailscale
	// keys (including tailnet-lock wrapped keys) and Headscale pre-auth keys
	// are far shorter.
	maxAuthKeyLen = 512

	// authKeyLoginResultTimeout bounds how long the helper watches for the
	// coordination server's verdict on a submitted key.
	authKeyLoginResultTimeout = 30 * time.Second
)

// validAuthKey reports whether key is a plausible auth key: non-empty, bounded,
// and printable ASCII without whitespace. The coordination server is the only
// authority on whether the key is actually valid, so the format is otherwise
// left open (Headscale pre-auth keys carry no "tskey-" prefix).
func validAuthKey(key string) bool {
	if key == "" || len(key) > maxAuthKeyLen {
		return false
	}
	for i := 0; i < len(key); i++ {
		if c := key[i]; c <= ' ' || c > '~' {
			return false
		}
	}
	return true
}

// redactAuthKey removes the key, and any substantial "--"-separated part of a
// wrapped key, from a message bound for the extension.
func redactAuthKey(msg, key string) string {
	if key == "" {
		return msg
	}
	msg = strings.ReplaceAll(msg, key, "[auth key]")
	for _, part := range strings.Split(key, "--") {
		if len(part) >= 8 {
			msg = strings.ReplaceAll(msg, part, "[auth key]")
		}
	}
	return msg
}

// handleLoginAuthKey registers the current logged-out profile with a
// pre-authorized auth key instead of an interactive browser login (#154).
//
// The key is handed to the backend's control client for this profile only.
// It is never written to prefs, the state store, or logs, and is dropped from
// the control client again if the coordination server rejects it.
func (h *Host) handleLoginAuthKey(req Request) {
	key := strings.TrimSpace(req.AuthKey)
	if !validAuthKey(key) {
		h.sendError(authKeyLoginCmd, "auth key is empty or malformed")
		return
	}

	_, lc, generation := h.sessionSnapshot()
	if lc == nil {
		h.sendError(authKeyLoginCmd, "host not initialized; send init command first")
		return
	}

	h.cancelStartupCorrection()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	st, err := lc.StatusWithoutPeers(ctx)
	if err != nil {
		h.sendError(authKeyLoginCmd, fmt.Sprintf("failed to read status: %v", err))
		return
	}
	if st.BackendState != ipn.NeedsLogin.String() {
		h.sendError(authKeyLoginCmd, fmt.Sprintf("auth key sign-in needs a logged-out profile (state %s)", st.BackendState))
		return
	}

	// Watch before starting so a fast rejection is not missed.
	watchCtx, stopWatch := context.WithTimeout(context.Background(), authKeyLoginResultTimeout)
	watcher, err := lc.WatchIPNBus(watchCtx, 0)
	if err != nil {
		stopWatch()
		h.sendError(authKeyLoginCmd, fmt.Sprintf("failed to watch login state: %v", err))
		return
	}

	// Mirror tsnet's own first-run path: Start installs a control client that
	// carries the key, and StartLoginInteractive registers with it. With a key
	// present, registration uses the key and no browser URL is produced.
	if err := lc.Start(ctx, ipn.Options{AuthKey: key}); err != nil {
		watcher.Close()
		stopWatch()
		h.sendError(authKeyLoginCmd, redactAuthKey(fmt.Sprintf("failed to start login: %v", err), key))
		return
	}
	if err := lc.StartLoginInteractive(ctx); err != nil {
		watcher.Close()
		stopWatch()
		h.discardAuthKeyLocked(lc, generation)
		h.sendError(authKeyLoginCmd, redactAuthKey(fmt.Sprintf("failed to start login: %v", err), key))
		return
	}

	go func() {
		defer stopWatch()
		defer watcher.Close()
		h.awaitAuthKeyLoginResult(watcher, lc, generation, key)
	}()
}

// ipnBusWatcher is the subset of local.IPNBusWatcher used here.
type ipnBusWatcher interface {
	Next() (ipn.Notify, error)
}

// awaitAuthKeyLoginResult reports a rejected or timed-out auth key login.
// Success needs no reply: the status watcher publishes the new state.
func (h *Host) awaitAuthKeyLoginResult(watcher ipnBusWatcher, lc *local.Client, generation uint64, key string) {
	// Start installs the keyed control client and then publishes the backend
	// state. Errors seen before that first state notification come from the
	// previous client (for example a failing interactive attempt) and say
	// nothing about this key.
	keyedClient := false
	for {
		n, err := watcher.Next()
		if err != nil {
			if !errors.Is(err, context.DeadlineExceeded) || !h.isCurrentSession(lc, generation) {
				return
			}
			h.commandMu.Lock()
			defer h.commandMu.Unlock()
			if h.stillNeedsLogin(lc, generation) {
				h.sendError(authKeyLoginCmd, "timed out waiting for the coordination server to accept the auth key")
			}
			return
		}
		if n.State != nil {
			keyedClient = true
		}
		if !keyedClient {
			continue
		}
		if n.ErrMessage != nil {
			h.commandMu.Lock()
			defer h.commandMu.Unlock()
			if !h.isCurrentSession(lc, generation) {
				return
			}
			h.discardAuthKeyLocked(lc, generation)
			h.sendError(authKeyLoginCmd, redactAuthKey("coordination server rejected the auth key: "+*n.ErrMessage, key))
			return
		}
		if n.LoginFinished != nil {
			return
		}
		if n.State != nil && *n.State != ipn.NoState && *n.State != ipn.NeedsLogin {
			return
		}
	}
}

// stillNeedsLogin reports whether the session is unchanged and still logged out.
func (h *Host) stillNeedsLogin(lc *local.Client, generation uint64) bool {
	if !h.isCurrentSession(lc, generation) {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	st, err := lc.StatusWithoutPeers(ctx)
	return err == nil && st.BackendState == ipn.NeedsLogin.String()
}

// discardAuthKeyLocked replaces a control client that still holds a rejected
// key, so the backend stops retrying it and the key leaves memory. The caller
// holds h.commandMu. Only a still-logged-out profile is reset, so a login the
// user started meanwhile is never interrupted.
func (h *Host) discardAuthKeyLocked(lc *local.Client, generation uint64) {
	if !h.stillNeedsLogin(lc, generation) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := lc.Start(ctx, ipn.Options{}); err != nil {
		h.sendError(authKeyLoginCmd, fmt.Sprintf("failed to reset login after a rejected auth key: %v", err))
	}
}
