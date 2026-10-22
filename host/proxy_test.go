package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/tailcfg"
)

func TestWebLocalClientDelegateFailureReturnsResponse(t *testing.T) {
	original := &local.Client{
		OmitAuth: true,
		Dial: func(context.Context, string, string) (net.Conn, error) {
			return nil, errors.New("local API unavailable")
		},
	}
	wrapped := newWebLocalClient(original)
	transition := &webLogoutTransition{beforeLogout: func() error { return nil }}
	ctx := context.WithValue(t.Context(), webLogoutTransitionKey{}, transition)
	req := httptest.NewRequest(http.MethodPost, "http://local-tailscaled.sock/localapi/v0/logout", nil).WithContext(ctx)
	req.RequestURI = ""
	response, err := wrapped.DoLocalRequest(req)
	if err != nil {
		t.Fatalf("wrapped logout returned error: %v", err)
	}
	if response == nil || response.StatusCode != http.StatusBadGateway {
		t.Fatalf("wrapped logout response = %#v, want HTTP %d", response, http.StatusBadGateway)
	}
	response.Body.Close()
}

func TestWebLocalClientResetsBeforeFailedLogoutDelegate(t *testing.T) {
	h := newHost(nil, nil)
	var observedGeneration uint64
	original := &local.Client{
		OmitAuth: true,
		Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			h.sessionMu.RLock()
			observedGeneration = h.sessionGeneration
			h.sessionMu.RUnlock()
			return &http.Response{
				StatusCode:    http.StatusInternalServerError,
				Status:        "500 Internal Server Error",
				Header:        make(http.Header),
				Body:          io.NopCloser(strings.NewReader("logout failed")),
				ContentLength: int64(len("logout failed")),
			}, nil
		}),
	}
	h.lc = original
	h.sessionGeneration = 7
	finishWebChange := h.beginWebSessionChange()
	var restartWatcher func()
	released := false
	var releaseTransition func()
	t.Cleanup(func() {
		if !released {
			if releaseTransition != nil {
				releaseTransition()
			} else {
				finishWebChange()
			}
		}
		h.sessionMu.Lock()
		cancelWatch := h.watchCancel
		h.watchCancel = nil
		h.sessionMu.Unlock()
		if cancelWatch != nil {
			cancelWatch()
		}
	})
	transition := &webLogoutTransition{beforeLogout: func() error {
		restartWatcher = h.beginProxyProfileChangeLocked(original, finishWebChange)
		releaseTransition = restartWatcher
		return nil
	}}
	ctx := context.WithValue(t.Context(), webLogoutTransitionKey{}, transition)
	req := httptest.NewRequest(http.MethodPost, "http://local-tailscaled.sock/localapi/v0/logout", nil).WithContext(ctx)
	req.RequestURI = ""
	response, err := newWebLocalClient(original).DoLocalRequest(req)
	if err != nil {
		t.Fatalf("wrapped failed logout returned error: %v", err)
	}
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("wrapped failed logout status = %d, want %d", response.StatusCode, http.StatusInternalServerError)
	}
	response.Body.Close()
	if observedGeneration != 8 {
		t.Fatalf("delegate observed generation %d, want reset generation 8", observedGeneration)
	}
	if restartWatcher == nil {
		t.Fatal("failed logout did not arrange watcher/admission restoration")
	}
	releaseTransition()
	released = true
	releaseTransition = nil
}

func TestWebLocalClientKeepsSubmittedLogoutAliveAfterDisconnect(t *testing.T) {
	started := make(chan struct{})
	delegatedContext := make(chan context.Context, 1)
	release := make(chan struct{})
	original := &local.Client{
		OmitAuth: true,
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			delegatedContext <- req.Context()
			close(started)
			select {
			case <-req.Context().Done():
				return nil, req.Context().Err()
			case <-release:
				return &http.Response{
					StatusCode:    http.StatusNoContent,
					Status:        "204 No Content",
					Header:        make(http.Header),
					Body:          io.NopCloser(strings.NewReader("")),
					ContentLength: 0,
				}, nil
			}
		}),
	}
	wrapped := newWebLocalClient(original)
	transition := &webLogoutTransition{beforeLogout: func() error { return nil }}
	parent, cancel := context.WithCancel(t.Context())
	var releaseOnce sync.Once
	t.Cleanup(func() {
		cancel()
		releaseOnce.Do(func() { close(release) })
	})
	ctx := context.WithValue(parent, webLogoutTransitionKey{}, transition)
	req := httptest.NewRequest(http.MethodPost, "http://local-tailscaled.sock/localapi/v0/logout", nil).WithContext(ctx)
	req.RequestURI = ""
	responseDone := make(chan *http.Response, 1)
	go func() {
		response, err := wrapped.DoLocalRequest(req)
		if err != nil {
			t.Errorf("wrapped logout returned error: %v", err)
			return
		}
		responseDone <- response
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("logout did not reach the LocalAPI delegate")
	}
	delegateCtx := <-delegatedContext
	cancel()
	if err := delegateCtx.Err(); err != nil {
		t.Fatalf("submitted logout delegate context canceled after browser disconnect: %v", err)
	}
	select {
	case <-delegateCtx.Done():
		t.Fatal("submitted logout delegate retained a cancelable context")
	default:
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case response := <-responseDone:
		defer response.Body.Close()
		if response.StatusCode != http.StatusNoContent {
			t.Fatalf("logout status = %d, want %d", response.StatusCode, http.StatusNoContent)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("submitted logout did not complete")
	}
}

func TestCommandEntriesWaitForWebTransitionAndDrain(t *testing.T) {
	h := newHost(nil, io.Discard)
	request := httptest.NewRequest(http.MethodPost, "http://100.100.100.100/api/routes", nil)
	_, finishRequest, admitted := h.beginWebRequest(httptest.NewRecorder(), request)
	if !admitted {
		t.Fatal("test mutation was not admitted")
	}
	var finishRequestOnce sync.Once
	releaseRequest := func() { finishRequestOnce.Do(finishRequest) }
	t.Cleanup(releaseRequest)

	// Web logout owns commandMu while its transition drains the already
	// admitted request. Exercise the actual native command and shutdown entry
	// points against that held ownership, rather than testing a helper-only
	// lock.
	h.commandMu.Lock()
	transitionDone := make(chan func(), 1)
	go func() { transitionDone <- h.beginWebSessionChange() }()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		h.webMu.Lock()
		changing := h.webChanging
		h.webMu.Unlock()
		if changing {
			break
		}
		select {
		case <-deadline.C:
			h.commandMu.Unlock()
			t.Fatal("web transition did not enter draining state")
		case <-ticker.C:
		}
	}
	nativeDone := make(chan struct{})
	go func() {
		h.handleRequest(Request{Cmd: "ping"})
		close(nativeDone)
	}()
	shutdownDone := make(chan struct{})
	go func() {
		h.shutdownSession()
		close(shutdownDone)
	}()
	select {
	case <-nativeDone:
		h.commandMu.Unlock()
		t.Fatal("native command overtook an in-progress web logout transition")
	case <-shutdownDone:
		h.commandMu.Unlock()
		t.Fatal("shutdown overtook an in-progress web logout transition")
	case <-time.After(50 * time.Millisecond):
	}

	releaseRequest()
	var finishTransition func()
	select {
	case finishTransition = <-transitionDone:
	case <-time.After(5 * time.Second):
		h.commandMu.Unlock()
		t.Fatal("web transition did not drain the admitted request")
	}
	finishTransition()
	h.commandMu.Unlock()
	select {
	case <-nativeDone:
	case <-time.After(5 * time.Second):
		t.Fatal("native command remained blocked after transition completion")
	}
	select {
	case <-shutdownDone:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown remained blocked after transition completion")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestWebClientAuthRequestReportsInvalidIdentityAndSession(t *testing.T) {
	lc := new(local.Client)
	h := newHost(nil, nil)
	h.lc = lc
	h.sessionGeneration = 2

	for _, tc := range []struct {
		name       string
		generation uint64
		source     uint64
		want       string
	}{
		{name: "missing source identity", generation: 2, want: "source identity is unavailable"},
		{name: "stale session", generation: 1, source: 1, want: "session changed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := h.webClientAuthRequest(t.Context(), nil, lc, tc.generation, "", tailcfg.NodeID(tc.source))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want text %q", err, tc.want)
			}
		})
	}
}

func TestHTTPProxyDoesNotFallThroughForUninitializedWebClient(t *testing.T) {
	h := newHost(nil, nil)
	h.proxyAuth = &ProxyAuth{Version: 1, Username: "test", Password: "test-password"}
	dialed := false
	h.proxyDial = func(context.Context, string, string) (net.Conn, error) {
		dialed = true
		return nil, nil
	}
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://100.100.100.100/", nil)
	req.Host = "100.100.100.100"
	req.Header.Set("Proxy-Authorization", "Basic dGVzdDp0ZXN0LXBhc3N3b3Jk")

	h.httpProxyHandler().ServeHTTP(recorder, req)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}
	if dialed {
		t.Fatal("quad-100 request fell through to the generic proxy")
	}
}

func TestHandleConnectForwardsBufferedClientBytes(t *testing.T) {
	h := newHost(nil, nil)
	upstream, target := net.Pipe()
	h.proxyDial = func(context.Context, string, string) (net.Conn, error) {
		return upstream, nil
	}
	serverConn, browserConn := net.Pipe()
	bufferedPayload := "already-buffered"
	buffered := bufio.NewReadWriter(
		bufio.NewReader(io.MultiReader(strings.NewReader(bufferedPayload), serverConn)),
		bufio.NewWriter(serverConn),
	)
	w := &hijackTestWriter{
		header:   make(http.Header),
		conn:     serverConn,
		buffered: buffered,
	}
	req := httptest.NewRequest(http.MethodConnect, "http://peer.example", nil)
	req.Host = "peer.example:443"
	done := make(chan struct{})
	go func() {
		h.handleConnect(w, req)
		close(done)
	}()

	browserReader := bufio.NewReader(browserConn)
	browserConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		line, err := browserReader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "\r\n" {
			break
		}
	}

	target.SetReadDeadline(time.Now().Add(2 * time.Second))
	got := make([]byte, len(bufferedPayload))
	if _, err := io.ReadFull(target, got); err != nil {
		t.Fatal(err)
	}
	if string(got) != bufferedPayload {
		t.Fatalf("forwarded bytes = %q, want %q", got, bufferedPayload)
	}

	browserConn.Close()
	target.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("CONNECT handler did not exit")
	}
}

// TestHandleConnectClosesClientWhenUpstreamCloses covers a hijacked conn that
// cannot half-close, like proxymux's wrapper (#152): the browser must still see
// EOF once the tailnet side closes, without closing its own side first.
func TestHandleConnectClosesClientWhenUpstreamCloses(t *testing.T) {
	h := newHost(nil, nil)
	upstream, target := net.Pipe()
	h.proxyDial = func(context.Context, string, string) (net.Conn, error) {
		return upstream, nil
	}
	serverConn, browserConn := net.Pipe()
	defer browserConn.Close()
	if _, ok := serverConn.(interface{ CloseWrite() error }); ok {
		t.Fatal("test client conn must not support CloseWrite")
	}
	w := &hijackTestWriter{
		header:   make(http.Header),
		conn:     serverConn,
		buffered: bufio.NewReadWriter(bufio.NewReader(serverConn), bufio.NewWriter(serverConn)),
	}
	req := httptest.NewRequest(http.MethodConnect, "http://peer.example", nil)
	req.Host = "peer.example:443"
	done := make(chan struct{})
	go func() {
		h.handleConnect(w, req)
		close(done)
	}()

	const reply = "goodbye"
	go func() {
		target.Write([]byte(reply))
		target.Close()
	}()

	browserConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	got, err := io.ReadAll(browserConn)
	if err != nil {
		t.Fatalf("browser did not see EOF after upstream closed: %v", err)
	}
	if want := "HTTP/1.1 200 Connection Established\r\n\r\n" + reply; string(got) != want {
		t.Fatalf("browser read %q, want %q", got, want)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("CONNECT handler did not exit after upstream closed")
	}
}

type hijackTestWriter struct {
	header   http.Header
	conn     net.Conn
	buffered *bufio.ReadWriter
	body     bytes.Buffer
}

func (w *hijackTestWriter) Header() http.Header         { return w.header }
func (w *hijackTestWriter) Write(p []byte) (int, error) { return w.body.Write(p) }
func (w *hijackTestWriter) WriteHeader(int)             {}
func (w *hijackTestWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return w.conn, w.buffered, nil
}
