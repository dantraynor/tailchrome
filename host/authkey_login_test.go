package main

import (
	"context"
	"net"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/ipn/store/mem"
	"tailscale.com/net/netns"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/logger"
)

func TestValidAuthKey(t *testing.T) {
	for _, key := range []string{
		"tskey-auth-kAbCdEf1CNTRL-0123456789abcdef",
		"0123456789abcdef0123456789abcdef0123456789abcdef", // Headscale pre-auth key
		strings.Repeat("a", maxAuthKeyLen),
	} {
		if !validAuthKey(key) {
			t.Errorf("validAuthKey(%q) = false, want true", key)
		}
	}
	for _, key := range []string{
		"",
		"tskey auth",
		"tskey-auth\n",
		"tskey-\x00",
		"tskey-é",
		strings.Repeat("a", maxAuthKeyLen+1),
	} {
		if validAuthKey(key) {
			t.Errorf("validAuthKey(%q) = true, want false", key)
		}
	}
}

func TestRedactAuthKey(t *testing.T) {
	const key = "tskey-auth-secretvalue123"
	got := redactAuthKey("invalid key "+key+" rejected", key)
	if strings.Contains(got, "secretvalue123") || !strings.Contains(got, "[auth key]") {
		t.Fatalf("redactAuthKey left the key in %q", got)
	}

	const wrapped = "tskey-auth-innersecret01--TLwrappedsignature01"
	got = redactAuthKey("bad inner tskey-auth-innersecret01 and TLwrappedsignature01", wrapped)
	if strings.Contains(got, "innersecret01") || strings.Contains(got, "wrappedsignature01") {
		t.Fatalf("redactAuthKey left a wrapped key part in %q", got)
	}

	if got := redactAuthKey("plain", ""); got != "plain" {
		t.Fatalf("redactAuthKey with empty key = %q", got)
	}
}

func TestLoginAuthKeyRejectsMalformedKeyWithoutEchoingIt(t *testing.T) {
	writer, reader := net.Pipe()
	defer writer.Close()
	defer reader.Close()
	h := newHost(nil, writer)

	go h.handleRequest(Request{Cmd: authKeyLoginCmd, AuthKey: "tskey bad secret"})
	reply := decodeReply(t, reader)
	if reply.Error == nil || reply.Error.Cmd != authKeyLoginCmd {
		t.Fatalf("reply = %+v, want login-auth-key error", reply)
	}
	if strings.Contains(reply.Error.Message, "secret") {
		t.Fatalf("error message echoes the key: %q", reply.Error.Message)
	}
}

func TestLoginAuthKeyRequiresInit(t *testing.T) {
	writer, reader := net.Pipe()
	defer writer.Close()
	defer reader.Close()
	h := newHost(nil, writer)

	go h.handleRequest(Request{Cmd: authKeyLoginCmd, AuthKey: "tskey-auth-ok"})
	reply := decodeReply(t, reader)
	if reply.Error == nil || reply.Error.Cmd != authKeyLoginCmd || !strings.Contains(reply.Error.Message, "init") {
		t.Fatalf("reply = %+v, want not-initialized error", reply)
	}
}

func TestLoginAuthKeyRegistersWithTestControl(t *testing.T) {
	if testing.Short() {
		t.Skip("starts an embedded tailnet node")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
	defer cancel()
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })

	const goodKey = "tskey-auth-integration-good"
	const badKey = "tskey-auth-integration-wrong"
	control := &testcontrol.Server{
		DERPMap:        splitDNSTestDERP(t),
		RequireAuthKey: goodKey,
		Logf:           logger.Discard,
	}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	t.Cleanup(control.HTTPTestServer.Close)

	node := &tsnet.Server{
		Dir: t.TempDir(), Hostname: "authkey-client", ControlURL: control.HTTPTestServer.URL,
		Store: new(mem.Store), Ephemeral: true, Logf: logger.Discard,
	}
	t.Cleanup(func() { node.Close() })
	if err := node.Start(); err != nil {
		t.Fatal(err)
	}
	lc, err := node.LocalClient()
	if err != nil {
		t.Fatal(err)
	}
	waitForBackendState(ctx, t, lc, ipn.NeedsLogin)

	writer, reader := net.Pipe()
	t.Cleanup(func() { writer.Close(); reader.Close() })
	h := newHost(nil, writer)
	h.ts, h.lc = node, lc

	// A rejected key is reported once, without the key, and the profile is
	// left logged out for another attempt.
	go h.handleRequest(Request{Cmd: authKeyLoginCmd, AuthKey: badKey})
	if err := reader.SetReadDeadline(time.Now().Add(20 * time.Second)); err != nil {
		t.Fatal(err)
	}
	reply := decodeReply(t, reader)
	if reply.Error == nil || reply.Error.Cmd != authKeyLoginCmd {
		t.Fatalf("reply = %+v, want login-auth-key error", reply)
	}
	if !strings.Contains(reply.Error.Message, "rejected") {
		t.Fatalf("error = %q, want rejection", reply.Error.Message)
	}
	if strings.Contains(reply.Error.Message, "integration-wrong") {
		t.Fatalf("error message echoes the key: %q", reply.Error.Message)
	}
	waitForBackendState(ctx, t, lc, ipn.NeedsLogin)

	// The right key registers the node without any browser login URL.
	go h.handleRequest(Request{Cmd: authKeyLoginCmd, AuthKey: goodKey})
	waitForBackendState(ctx, t, lc, ipn.Running)
	st, err := lc.StatusWithoutPeers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.AuthURL != "" {
		t.Fatalf("auth key login produced an interactive URL %q", st.AuthURL)
	}
	prefs, err := lc.GetPrefs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !prefs.WantRunning {
		t.Fatal("auth key login left WantRunning=false")
	}
}

func waitForBackendState(ctx context.Context, t *testing.T, lc *local.Client, want ipn.State) {
	t.Helper()
	var last string
	for {
		if st, err := lc.StatusWithoutPeers(ctx); err == nil {
			last = st.BackendState
			if last == want.String() {
				return
			}
		}
		select {
		case <-ctx.Done():
			t.Fatalf("backend state = %q, want %v", last, want)
		case <-time.After(100 * time.Millisecond):
		}
	}
}
