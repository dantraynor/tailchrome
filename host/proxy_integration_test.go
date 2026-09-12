package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/ipn/store/mem"
	"tailscale.com/net/netns"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/logger"
)

func TestHTTPProxyServesAuthenticatedWebClient(t *testing.T) {
	if testing.Short() {
		t.Skip("starts an embedded tailnet node")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })

	control := &testcontrol.Server{
		DERPMap: splitDNSTestDERP(t),
		Logf:    logger.Discard,
	}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	t.Cleanup(control.HTTPTestServer.Close)

	node := &tsnet.Server{
		Dir:          t.TempDir(),
		Hostname:     "web-client-test",
		ControlURL:   control.HTTPTestServer.URL,
		Store:        new(mem.Store),
		Ephemeral:    true,
		RunWebClient: true,
		Logf:         logger.Discard,
	}
	t.Cleanup(func() { node.Close() })
	if _, err := node.Up(ctx); err != nil {
		t.Fatal(err)
	}
	lc, err := node.LocalClient()
	if err != nil {
		t.Fatal(err)
	}
	watcher, err := lc.WatchIPNBus(ctx, ipn.NotifyInitialNetMap)
	if err != nil {
		t.Fatal(err)
	}
	defer watcher.Close()
	notify, err := watcher.Next()
	if err != nil {
		t.Fatal(err)
	}
	if notify.NetMap == nil {
		t.Fatal("initial notification did not include a network map")
	}

	h := newHost(nil, nil)
	h.ts = node
	h.lc = lc
	h.sessionGeneration = 1
	h.lastNetMap = notify.NetMap
	h.proxyAuth = &ProxyAuth{Version: 1, Username: "test", Password: "test-password"}
	request := func(path string) *httptest.ResponseRecorder {
		t.Helper()
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "http://100.100.100.100"+path, nil)
		req.Host = "100.100.100.100"
		req.Header.Set("Proxy-Authorization", "Basic dGVzdDp0ZXN0LXBhc3N3b3Jk")
		h.httpProxyHandler().ServeHTTP(recorder, req)
		return recorder
	}

	root := request("/")
	if root.Code != http.StatusOK {
		t.Fatalf("root status = %d, want %d; body: %s", root.Code, http.StatusOK, root.Body.String())
	}
	if body := root.Body.String(); !strings.Contains(body, "Tailscale") {
		t.Fatalf("response did not contain the Tailscale web client: %q", body)
	}

	authStatus := request("/api/auth")
	if authStatus.Code != http.StatusOK {
		t.Fatalf("auth status = %d, want %d; body: %s", authStatus.Code, http.StatusOK, authStatus.Body.String())
	}
	var statusBody struct {
		ServerMode     string          `json:"serverMode"`
		ViewerIdentity json.RawMessage `json:"viewerIdentity"`
	}
	if err := json.Unmarshal(authStatus.Body.Bytes(), &statusBody); err != nil {
		t.Fatal(err)
	}
	if statusBody.ServerMode != "manage" || len(statusBody.ViewerIdentity) == 0 {
		t.Fatalf("auth response did not identify the local managing node: %s", authStatus.Body.String())
	}

	newAuth, err := h.webClientAuthRequest(ctx, node, lc, 1, "", notify.NetMap.SelfNode.ID())
	if err != nil {
		t.Fatal(err)
	}
	if newAuth.ID != "testcontrol-webclient-auth" || newAuth.URL != "https://control.tailscale/test-web-auth" {
		t.Fatalf("new auth response = %+v", newAuth)
	}
	waitAuth, err := h.webClientAuthRequest(ctx, node, lc, 1, newAuth.ID, notify.NetMap.SelfNode.ID())
	if err != nil {
		t.Fatal(err)
	}
	if !waitAuth.Complete {
		t.Fatalf("wait auth response = %+v, want complete", waitAuth)
	}

	if h.webCache == nil {
		t.Fatal("web server was not cached")
	}
	h.beginProxyProfileChange(lc)
	if h.webCache != nil {
		t.Fatal("profile change retained the previous profile's web server")
	}
}
