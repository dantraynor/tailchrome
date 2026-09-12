package main

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/tailcfg"
)

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
