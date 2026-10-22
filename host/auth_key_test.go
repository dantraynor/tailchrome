package main

import (
	"bytes"
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/net/netns"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/logger"
)

func TestValidateAuthKey(t *testing.T) {
	for _, key := range []string{
		"tskey-auth-kAbCdEf1CNTRL-0123456789abcdef",
		"hskey-auth-0123456789abcdef",
		"0123456789abcdef0123456789abcdef0123456789abcdef",
	} {
		if err := validateAuthKey(key); err != nil {
			t.Errorf("validateAuthKey(%q) = %v; want accepted", key, err)
		}
	}
	for key, want := range map[string]string{
		"tskey-auth-abc def":            "spaces",
		"tskey-auth-abc\n":              "spaces",
		"tskey-auth-é":                  "non-ASCII",
		strings.Repeat("k", 513):        "too long",
		"tskey-client-kAbCdEf1CNTRL-01": "OAuth client secrets",
	} {
		err := validateAuthKey(key)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("validateAuthKey(%.20q) = %v; want error containing %q", key, err, want)
		}
		if err != nil && strings.Contains(err.Error(), key) {
			t.Errorf("validateAuthKey error echoes the key: %v", err)
		}
	}
}

func TestHandleLoginRejectsInvalidAuthKeyWithoutEchoingIt(t *testing.T) {
	var out bytes.Buffer
	h := newHost(nil, &out)
	h.handleLogin(Request{Cmd: "login", AuthKey: "tskey-client-secret-value"})
	if !strings.Contains(out.String(), "OAuth client secrets are not supported") {
		t.Fatalf("login reply = %s; want the OAuth client secret rejection", out.String())
	}
	if strings.Contains(out.String(), "secret-value") {
		t.Fatalf("login error echoed the auth key: %s", out.String())
	}
}

// TestHandleLoginWithAuthKeyRegistersNode signs a logged-out node in with an
// auth key through the native-messaging login handler (#154), and checks that
// the key is not written to the node's state.
func TestHandleLoginWithAuthKeyRegistersNode(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
	defer cancel()
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })

	const authKey = "tskey-auth-test0123456789"
	control := &testcontrol.Server{
		DERPMap:        splitDNSTestDERP(t),
		RequireAuthKey: authKey,
		Logf:           logger.Discard,
	}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	t.Cleanup(control.HTTPTestServer.Close)

	stateDir := t.TempDir()
	node := &tsnet.Server{
		Dir:        stateDir,
		Hostname:   "auth-key-test",
		ControlURL: control.HTTPTestServer.URL,
		Logf:       logger.Discard,
	}
	t.Cleanup(func() { node.Close() })
	if err := node.Start(); err != nil {
		t.Fatal(err)
	}
	lc, err := node.LocalClient()
	if err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	h := newHost(nil, &out)
	h.ts = node
	h.lc = lc
	h.sessionGeneration = 1
	h.handleLogin(Request{Cmd: "login", AuthKey: authKey})
	if strings.Contains(out.String(), `"error"`) {
		t.Fatalf("login replied with an error: %s", out.String())
	}

	for {
		st, err := lc.StatusWithoutPeers(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if st.BackendState == ipn.Running.String() {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("node did not reach Running after auth-key login; state %s", st.BackendState)
		case <-time.After(50 * time.Millisecond):
		}
	}

	prefs, err := lc.GetPrefs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !prefs.WantRunning || prefs.ControlURL != control.HTTPTestServer.URL {
		t.Fatalf("prefs after auth-key login = %v", prefs.Pretty())
	}
	state, err := os.ReadFile(filepath.Join(stateDir, "tailscaled.state"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(state, []byte(authKey)) {
		t.Fatal("auth key was written to the node state")
	}
}
