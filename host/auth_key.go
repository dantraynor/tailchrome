package main

import (
	"context"
	"errors"
	"strings"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
)

// maxAuthKeyLength bounds a pasted auth key. Tailscale keys are under 100
// characters; the limit only rejects pasted documents.
const maxAuthKeyLength = 512

// validateAuthKey rejects values that cannot be an auth key before they reach
// the backend. Keys are not limited to the tskey-auth- prefix because custom
// coordination servers such as Headscale issue their own pre-auth keys.
func validateAuthKey(key string) error {
	if len(key) > maxAuthKeyLength {
		return errors.New("auth key is too long")
	}
	for _, r := range key {
		if r <= ' ' || r > '~' {
			return errors.New("auth key must not contain spaces or non-ASCII characters")
		}
	}
	// OAuth client secrets are exchanged for an auth key by tsnet's own
	// startup, not by the local backend this login goes through.
	if strings.HasPrefix(key, "tskey-client-") {
		return errors.New("OAuth client secrets are not supported; generate an auth key instead")
	}
	return nil
}

// loginWithAuthKey registers the current profile with a pre-authorized key,
// the same way `tailscale up --auth-key` does: restart the backend with the
// key and the current prefs set to run, then start login so the control
// client sends the key. The key is held only in the backend's control client
// for this login; prefs and profile state never contain it (#154).
func loginWithAuthKey(ctx context.Context, lc *local.Client, key string) error {
	prefs, err := lc.GetPrefs(ctx)
	if err != nil {
		return err
	}
	prefs.WantRunning = true
	if err := lc.Start(ctx, ipn.Options{AuthKey: key, UpdatePrefs: prefs}); err != nil {
		return err
	}
	return lc.StartLoginInteractive(ctx)
}
