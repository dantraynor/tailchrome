package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/client/web"
	"tailscale.com/net/proxymux"
	"tailscale.com/net/socks5"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
)

const maxWebClientAuthResponseSize = 64 << 10

type webServerCache struct {
	client     *local.Client
	generation uint64
	server     *web.Server
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

		// Route requests to 100.100.100.100 to the local web client. The
		// authenticated loopback proxy is outside the tailnet, so present the
		// request as originating from this tsnet node before the web client runs
		// its separate control-plane authorization flow.
		if host == "100.100.100.100" {
			webServer, remoteAddr, err := h.currentWebServer(r.Context())
			if err != nil {
				http.Error(w, err.Error(), http.StatusServiceUnavailable)
				return
			}
			r.Header.Set("Sec-Tailscale", "browser-ext")
			r.RemoteAddr = remoteAddr
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

func (h *Host) currentWebServer(ctx context.Context) (*web.Server, string, error) {
	ts, lc, generation := h.sessionSnapshot()
	if ts == nil || lc == nil {
		return nil, "", fmt.Errorf("Tailscale web client is not initialized")
	}
	remoteAddr, err := webClientRemoteAddr(ctx, lc)
	if err != nil {
		return nil, "", err
	}

	// Keep session replacement from racing a stale server into the cache after
	// handleInit has detached the old tsnet instance and cleared its web state.
	h.sessionMu.RLock()
	if h.ts != ts || h.lc != lc || h.sessionGeneration != generation {
		h.sessionMu.RUnlock()
		return nil, "", fmt.Errorf("Tailscale web client session changed")
	}
	h.webMu.Lock()
	if h.webCache != nil && h.webCache.client == lc && h.webCache.generation == generation {
		server := h.webCache.server
		h.webMu.Unlock()
		h.sessionMu.RUnlock()
		return server, remoteAddr, nil
	}
	server, err := web.NewServer(web.ServerOpts{
		Mode:        web.ManageServerMode,
		LocalClient: lc,
		Logf:        log.Printf,
		NewAuthURL: func(ctx context.Context, src tailcfg.NodeID) (*tailcfg.WebClientAuthResponse, error) {
			return h.webClientAuthRequest(ctx, ts, lc, generation, "", src)
		},
		WaitAuthURL: func(ctx context.Context, id string, src tailcfg.NodeID) (*tailcfg.WebClientAuthResponse, error) {
			return h.webClientAuthRequest(ctx, ts, lc, generation, id, src)
		},
	})
	if err != nil {
		h.webMu.Unlock()
		h.sessionMu.RUnlock()
		return nil, "", fmt.Errorf("failed to create Tailscale web client: %w", err)
	}
	old := h.webCache
	h.webCache = &webServerCache{client: lc, generation: generation, server: server}
	h.webMu.Unlock()
	h.sessionMu.RUnlock()
	if old != nil {
		old.server.Shutdown()
	}
	return server, remoteAddr, nil
}

func webClientRemoteAddr(ctx context.Context, lc *local.Client) (string, error) {
	status, err := lc.StatusWithoutPeers(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to read the local Tailscale identity: %w", err)
	}
	if status.Self == nil || status.Self.NodeID == 0 {
		return "", fmt.Errorf("local Tailscale identity is unavailable")
	}
	for _, ip := range status.Self.TailscaleIPs {
		if ip.Is4() {
			return net.JoinHostPort(ip.String(), "0"), nil
		}
	}
	if len(status.Self.TailscaleIPs) > 0 {
		return net.JoinHostPort(status.Self.TailscaleIPs[0].String(), "0"), nil
	}
	return "", fmt.Errorf("local Tailscale address is unavailable")
}

func (h *Host) webClientAuthRequest(
	ctx context.Context,
	ts *tsnet.Server,
	lc *local.Client,
	generation uint64,
	id string,
	src tailcfg.NodeID,
) (*tailcfg.WebClientAuthResponse, error) {
	if src == 0 || !h.isCurrentSession(lc, generation) {
		return nil, fmt.Errorf("Tailscale web client session changed")
	}
	status, err := lc.StatusWithoutPeers(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to read the local Tailscale identity: %w", err)
	}
	if status.Self == nil || status.Self.NodeID == 0 || !h.isCurrentSession(lc, generation) {
		return nil, fmt.Errorf("local Tailscale identity is unavailable")
	}

	path := fmt.Sprintf("/machine/webclient/init/%d/to/%d", src, status.Self.NodeID)
	if id != "" {
		path = fmt.Sprintf("/machine/webclient/wait/%d/to/%d/%s", src, status.Self.NodeID, url.PathEscape(id))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://unused"+path, http.NoBody)
	if err != nil {
		return nil, fmt.Errorf("failed to create web client authentication request: %w", err)
	}
	roundTripper, ok := ts.Sys().NoiseRoundTripper.GetOK()
	if !ok {
		return nil, fmt.Errorf("Tailscale control connection is unavailable")
	}
	resp, err := roundTripper.RoundTrip(req)
	if err != nil {
		return nil, fmt.Errorf("web client authentication request failed: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxWebClientAuthResponseSize+1))
	if err != nil {
		return nil, fmt.Errorf("failed to read web client authentication response: %w", err)
	}
	if len(body) > maxWebClientAuthResponseSize {
		return nil, fmt.Errorf("web client authentication response is too large")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("web client authentication request returned %s", resp.Status)
	}
	var auth tailcfg.WebClientAuthResponse
	if err := json.Unmarshal(body, &auth); err != nil {
		return nil, fmt.Errorf("invalid web client authentication response: %w", err)
	}
	if !h.isCurrentSession(lc, generation) {
		return nil, fmt.Errorf("Tailscale web client session changed")
	}
	return &auth, nil
}

func (h *Host) clearWebServer() {
	h.webMu.Lock()
	cache := h.webCache
	h.webCache = nil
	h.webMu.Unlock()
	if cache != nil {
		cache.server.Shutdown()
	}
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
