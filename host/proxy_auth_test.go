package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func proxyAuthorization(h *Host) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(h.proxyAuth.Username+":"+h.proxyAuth.Password))
}

func TestProxyAuthenticatesAllHTTPPaths(t *testing.T) {
	for _, tc := range []struct{ method, target string }{{"GET", "http://100.64.0.2/"}, {"CONNECT", "http://100.64.0.2:443"}, {"GET", "http://100.100.100.100/"}} {
		t.Run(tc.method+tc.target, func(t *testing.T) {
			h := newHost(nil, nil)
			h.proxyAuth = &ProxyAuth{Version: 1, Username: "user", Password: "secret"}
			h.proxyDial = func(context.Context, string, string) (net.Conn, error) {
				t.Error("unauthenticated request dialed")
				return nil, fmt.Errorf("denied")
			}
			for _, header := range []string{"", "Basic dXNlcjp3cm9uZw==", "Bearer secret"} {
				req := httptest.NewRequest(tc.method, tc.target, nil)
				req.Header.Set("Proxy-Authorization", header)
				res := httptest.NewRecorder()
				h.httpProxyHandler().ServeHTTP(res, req)
				if res.Code != http.StatusProxyAuthRequired || res.Header().Get("Proxy-Authenticate") == "" {
					t.Fatalf("authentication not enforced: %d", res.Code)
				}
			}
		})
	}
}

func TestAuthenticatedHTTPStripsProxyCredentials(t *testing.T) {
	seen := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Get("Proxy-Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	h := newHost(nil, nil)
	h.proxyAuth = &ProxyAuth{Version: 1, Username: "user", Password: "secret"}
	h.proxyDial = func(ctx context.Context, network, address string) (net.Conn, error) {
		var dialer net.Dialer
		return dialer.DialContext(ctx, network, upstream.Listener.Addr().String())
	}
	req := httptest.NewRequest("GET", "http://100.64.0.2/", nil)
	req.Header.Set("Proxy-Authorization", proxyAuthorization(h))
	res := httptest.NewRecorder()
	h.httpProxyHandler().ServeHTTP(res, req)
	if res.Code != http.StatusNoContent {
		t.Fatalf("status = %d", res.Code)
	}
	if header := <-seen; header != "" {
		t.Fatal("proxy credential reached upstream")
	}
}

func TestSOCKSRequiresProcessCredential(t *testing.T) {
	h := newHost(nil, nil)
	port, err := h.startProxy()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.proxyListener.Close() })
	connect := func() net.Conn {
		conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			t.Fatal(err)
		}
		conn.SetDeadline(time.Now().Add(2 * time.Second))
		t.Cleanup(func() { conn.Close() })
		return conn
	}
	c := connect()
	c.Write([]byte{5, 1, 0})
	response := make([]byte, 2)
	if _, err := io.ReadFull(c, response); err != nil {
		t.Fatal(err)
	}
	if response[1] != 255 {
		t.Fatalf("no-auth accepted: %v", response)
	}
	for _, password := range []string{"wrong", h.proxyAuth.Password} {
		c := connect()
		c.Write([]byte{5, 1, 2})
		if _, err := io.ReadFull(c, response); err != nil {
			t.Fatal(err)
		}
		if response[1] != 2 {
			t.Fatalf("password method not selected: %v", response)
		}
		payload := append([]byte{1, byte(len(h.proxyAuth.Username))}, []byte(h.proxyAuth.Username)...)
		payload = append(payload, byte(len(password)))
		payload = append(payload, []byte(password)...)
		c.Write(payload)
		if _, err := io.ReadFull(c, response); err != nil {
			t.Fatal(err)
		}
		if (response[1] == 0) != (password == h.proxyAuth.Password) {
			t.Fatalf("incorrect auth result: %v", response)
		}
	}
}

func TestProxyCredentialRotatesWithHelper(t *testing.T) {
	first, second := newHost(nil, nil), newHost(nil, nil)
	for _, h := range []*Host{first, second} {
		if _, err := h.startProxy(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { h.proxyListener.Close() })
	}
	if first.proxyAuth.Password == second.proxyAuth.Password {
		t.Fatal("credential reused")
	}
	req := httptest.NewRequest("GET", "http://100.100.100.100/", nil)
	req.Header.Set("Proxy-Authorization", proxyAuthorization(first))
	if second.authenticateProxyRequest(req) {
		t.Fatal("old helper credential accepted")
	}
}

func TestAuthenticatedConnectEstablishesTunnel(t *testing.T) {
	h := newHost(nil, nil)
	h.proxyAuth = &ProxyAuth{Version: 1, Username: "user", Password: "secret"}
	upstream, target := net.Pipe()
	defer target.Close()
	h.proxyDial = func(context.Context, string, string) (net.Conn, error) { return upstream, nil }
	proxy := httptest.NewServer(h.httpProxyHandler())
	defer proxy.Close()
	conn, err := net.Dial("tcp", proxy.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(2 * time.Second))
	fmt.Fprintf(conn, "CONNECT 100.64.0.2:443 HTTP/1.1\r\nHost: 100.64.0.2:443\r\nProxy-Authorization: %s\r\n\r\n", proxyAuthorization(h))
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
}
