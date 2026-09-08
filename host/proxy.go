package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"strings"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/client/web"
	"tailscale.com/net/proxymux"
	"tailscale.com/net/socks5"
)

type webServerCache struct {
	client *local.Client
	server *web.Server
}

// startProxy starts an HTTP+SOCKS5 proxy on 127.0.0.1:0 and returns the port.
// Protected connections use the userspace network stack after destination validation.
func (h *Host) startProxy() (int, error) {
	h.proxyAuth = &ProxyAuth{Version: 1, Username: "tailchrome", Password: rand.Text() + rand.Text()}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("failed to listen: %w", err)
	}

	h.proxyListener = ln
	port := ln.Addr().(*net.TCPAddr).Port

	// Split the listener into SOCKS5 and HTTP listeners.
	socksLn, httpLn := proxymux.SplitSOCKSAndHTTP(ln)

	// Start the SOCKS5 proxy.
	socksServer := &socks5.Server{
		Logf:     func(string, ...any) {},
		Username: h.proxyAuth.Username,
		Password: h.proxyAuth.Password,
		Dialer:   h.tsnetDialer,
	}
	go func() {
		if err := socksServer.Serve(socksLn); err != nil {
			log.Printf("SOCKS5 server error: %v", err)
		}
	}()

	// Start the HTTP proxy.
	go func() {
		if err := h.serveHTTPProxy(httpLn); err != nil {
			log.Printf("HTTP proxy server error: %v", err)
		}
	}()

	return port, nil
}

// tsnetDialer dials through the tsnet.Server.
func (h *Host) tsnetDialer(ctx context.Context, network, addr string) (net.Conn, error) {
	if h.proxyDial != nil {
		return h.proxyDial(ctx, network, addr)
	}
	ts, _, _ := h.sessionSnapshot()
	if ts == nil {
		return nil, fmt.Errorf("tsnet server not initialized")
	}
	return h.dialAllowedProxyDestination(ctx, ts, network, addr)
}

// serveHTTPProxy serves HTTP proxy requests, routing 100.100.100.100 to the
// Tailscale web client and everything else through the tailnet.
func (h *Host) serveHTTPProxy(ln net.Listener) error {
	server := &http.Server{Handler: h.httpProxyHandler(), ReadHeaderTimeout: 10 * time.Second}
	return server.Serve(ln)
}

func (h *Host) httpProxyHandler() http.Handler {
	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			// No-op: we handle the request ourselves.
		},
		Transport: &http.Transport{
			DialContext:       h.tsnetDialer,
			DisableKeepAlives: true,
		},
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.authenticateProxyRequest(r) {
			w.Header().Set("Proxy-Authenticate", `Basic realm="Tailchrome"`)
			http.Error(w, "Proxy authentication required", http.StatusProxyAuthRequired)
			return
		}
		r.Header.Del("Proxy-Authorization")
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}

		// Route requests to 100.100.100.100 to the web client.
		if host == "100.100.100.100" {
			webServer, err := h.currentWebServer()
			if err != nil {
				http.Error(w, err.Error(), http.StatusServiceUnavailable)
				return
			}
			// Set the Sec-Tailscale header for CSRF protection.
			// The web client expects this for plaintext connections.
			r.Header.Set("Sec-Tailscale", "browser-ext")
			webServer.ServeHTTP(w, r)
			return
		}

		// Handle CONNECT method for HTTPS tunneling.
		if r.Method == http.MethodConnect {
			h.handleConnect(w, r)
			return
		}

		// Forward regular HTTP requests through tsnet.
		proxy.ServeHTTP(w, r)
	})
}

func (h *Host) currentWebServer() (*web.Server, error) {
	_, lc, _ := h.sessionSnapshot()
	if lc == nil {
		return nil, fmt.Errorf("Tailscale web client is not initialized")
	}

	h.webMu.Lock()
	defer h.webMu.Unlock()
	if h.webCache != nil && h.webCache.client == lc {
		return h.webCache.server, nil
	}
	server, err := web.NewServer(web.ServerOpts{
		Mode:        web.ManageServerMode,
		LocalClient: lc,
		Logf:        log.Printf,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create Tailscale web client: %w", err)
	}
	h.webCache = &webServerCache{client: lc, server: server}
	return server, nil
}

// handleConnect handles the HTTP CONNECT method for HTTPS tunneling.
// It hijacks the connection and creates a bidirectional tunnel through tsnet.
func (h *Host) handleConnect(w http.ResponseWriter, r *http.Request) {
	target := r.Host
	if !strings.Contains(target, ":") {
		target = target + ":443"
	}

	ctx := r.Context()
	upstream, err := h.tsnetDialer(ctx, "tcp", target)
	if err != nil {
		http.Error(w, fmt.Sprintf("failed to connect to %s: %v", target, err), http.StatusBadGateway)
		return
	}
	defer upstream.Close()

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijacking not supported", http.StatusInternalServerError)
		return
	}

	// Hijack first, then write the 200 response directly to the raw connection
	// so the response is not buffered by the HTTP response writer.
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		log.Printf("failed to hijack connection: %v", err)
		return
	}
	defer client.Close()

	if _, err := fmt.Fprint(buffered, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		log.Printf("failed to write CONNECT response: %v", err)
		return
	}
	if err := buffered.Flush(); err != nil {
		log.Printf("failed to flush CONNECT response: %v", err)
		return
	}

	// Bidirectional copy. When one direction reaches EOF, half-close the
	// write side so the other direction can drain remaining bytes before
	// the deferred client.Close() tears down the full connection.
	done := make(chan struct{}, 2)
	go func() {
		io.Copy(upstream, buffered.Reader)
		if cw, ok := upstream.(interface{ CloseWrite() error }); ok {
			cw.CloseWrite()
		}
		done <- struct{}{}
	}()
	go func() {
		io.Copy(client, upstream)
		if cw, ok := client.(interface{ CloseWrite() error }); ok {
			cw.CloseWrite()
		}
		done <- struct{}{}
	}()
	<-done
	<-done
}

func (h *Host) authenticateProxyRequest(r *http.Request) bool {
	if h.proxyAuth == nil {
		return false
	}
	const prefix = "Basic "
	value := r.Header.Get("Proxy-Authorization")
	if len(value) < len(prefix) || !strings.EqualFold(value[:len(prefix)], prefix) {
		return false
	}
	decoded, err := base64.StdEncoding.DecodeString(value[len(prefix):])
	if err != nil {
		return false
	}
	expected := h.proxyAuth.Username + ":" + h.proxyAuth.Password
	return subtle.ConstantTimeCompare(decoded, []byte(expected)) == 1
}
