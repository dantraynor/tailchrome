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
	"sync"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/client/web"
	"tailscale.com/net/netutil"
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
		Dialer:   h.socksDialer,
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

// socksDialer runs only after the SOCKS server has authenticated the process
// credential. Firefox uses SOCKS for the local web client as well as tailnet
// traffic; Quad100's HTTP service lives in this helper, not in tsnet's netstack.
func (h *Host) socksDialer(ctx context.Context, network, addr string) (net.Conn, error) {
	if network != "tcp" || addr != "100.100.100.100:80" {
		return h.tsnetDialer(ctx, network, addr)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	client, server := net.Pipe()
	webHTTP := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// This authenticated stream is a single local HTTP origin, never
			// an additional forwarding proxy or CONNECT tunnel.
			if r.Method == http.MethodConnect || !localWebAuthority(r.Host) ||
				(r.URL.Host != "" && !localWebAuthority(r.URL.Host)) ||
				(r.URL.Scheme != "" && r.URL.Scheme != "http") || r.URL.User != nil {
				http.Error(w, "Invalid local web client request", http.StatusBadRequest)
				return
			}
			r.Header.Del("Proxy-Authorization")
			h.serveLocalWebClient(w, r)
		}),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	go func() {
		// Serve returns EOF after accepting its one connection; net/http
		// continues serving and owns closing that connection. Do not close
		// it when Serve returns or attach the request to the dial timeout.
		webHTTP.Serve(netutil.NewOneConnListener(server, nil))
	}()
	return localWebSOCKSConn{client}, nil
}

func localWebAuthority(authority string) bool {
	return authority == "100.100.100.100" || authority == "100.100.100.100:80"
}

type localWebSOCKSConn struct{ net.Conn }

// The SOCKS server uses LocalAddr in its RFC 1928 reply. net.Pipe's placeholder
// address is not a host:port and cannot be encoded in that reply.
func (c localWebSOCKSConn) LocalAddr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)}
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
		// Chrome primes its proxy credential cache before routing requests from
		// other extensions (whose auth challenges it cannot observe). Keep the
		// probe local and independent of tsnet, exit nodes and RunWebClient.
		if r.Method == http.MethodHead && r.URL.Scheme == "http" &&
			r.Host == "tailchrome-proxy-auth.invalid" && r.URL.Path == "/" {
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}

		// The proxy credential has been checked before entering the local
		// web client's separate control-plane authorization flow.
		if host == "100.100.100.100" {
			h.serveLocalWebClient(w, r)
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

// serveLocalWebClient is entered only after HTTP or SOCKS proxy authentication.
// Present the authenticated loopback request as coming from this tsnet node;
// the web server still checks its browser session, capabilities and CSRF token.
func (h *Host) serveLocalWebClient(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost && r.URL.Path == "/api/local/v0/logout" {
		h.commandMu.Lock()
		defer h.commandMu.Unlock()
		h.handleWebLogoutLocked(w, r)
		return
	}
	r, finish, ok := h.beginWebRequest(w, r)
	if !ok {
		http.Error(w, "Tailscale web client session is changing", http.StatusServiceUnavailable)
		return
	}
	defer finish()
	webServer, remoteAddr, err := h.currentWebServer(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	r.Header.Set("Sec-Tailscale", "browser-ext")
	r.RemoteAddr = remoteAddr
	webServer.ServeHTTP(w, r)
}

// handleWebLogout runs the web client's authenticated logout as an account
// transition. The logout request itself is deliberately not admitted through
// beginWebRequest: waiting for a web request count that includes this handler
// would deadlock. The web.Server still performs the normal browser-session,
// capability, and CSRF checks before its LocalAPI logout call.
func (h *Host) handleWebLogoutLocked(w http.ResponseWriter, r *http.Request) {
	_, lc, _ := h.sessionSnapshot()
	if lc == nil {
		http.Error(w, "Tailscale web client is not initialized", http.StatusServiceUnavailable)
		return
	}

	finishWebChange := h.beginWebSessionChange()
	var restartWatcher func()
	transition := &webLogoutTransition{
		beforeLogout: func() error {
			h.cancelStartupCorrection()
			restartWatcher = h.beginProxyProfileChangeLocked(lc, finishWebChange)
			return nil
		},
	}
	defer func() {
		if restartWatcher != nil {
			restartWatcher()
		} else {
			finishWebChange()
		}
	}()
	webServer, remoteAddr, err := h.currentWebServer(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	r.Header.Set("Sec-Tailscale", "browser-ext")
	r.RemoteAddr = remoteAddr
	r = r.WithContext(context.WithValue(r.Context(), webLogoutTransitionKey{}, transition))
	webServer.ServeHTTP(w, r)
}

type webLogoutTransitionKey struct{}

type webLogoutTransition struct {
	beforeLogout func() error
	once         sync.Once
	err          error
}

func (t *webLogoutTransition) begin() error {
	t.once.Do(func() { t.err = t.beforeLogout() })
	return t.err
}

// newWebLocalClient gives each web.Server a fresh local.Client whose transport
// delegates to the already-initialized client. It is intentionally not a copy
// of the original local.Client: that type contains sync.Once state. The
// wrapper observes the serialized, authenticated logout request at the HTTP
// boundary immediately before delegating it to the original client.
func newWebLocalClient(original *local.Client) *local.Client {
	return &local.Client{
		OmitAuth:  true,
		Transport: webLocalRoundTripper{original: original},
	}
}

type webLocalRoundTripper struct {
	original *local.Client
}

func (t webLocalRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Method == http.MethodPost && req.URL.Path == "/localapi/v0/logout" {
		transition, ok := req.Context().Value(webLogoutTransitionKey{}).(*webLogoutTransition)
		if !ok {
			err := fmt.Errorf("web logout missing transition context")
			return webLocalAPIErrorResponse(http.StatusForbidden, err), nil
		}
		if err := transition.begin(); err != nil {
			return webLocalAPIErrorResponse(http.StatusServiceUnavailable, err), nil
		}
		// The web.Server has already completed browser-session, CSRF, and
		// capability checks. Preserve this submitted identity mutation even if
		// the browser disconnects while LocalAPI is processing it.
		req = req.WithContext(context.WithoutCancel(req.Context()))
	}
	response, err := t.original.DoLocalRequest(req)
	if err != nil {
		if response == nil {
			response = webLocalAPIErrorResponse(http.StatusBadGateway, err)
		}
		return response, nil
	}
	return response, nil
}

func webLocalAPIErrorResponse(status int, err error) *http.Response {
	body := err.Error() + "\n"
	return &http.Response{
		StatusCode:    status,
		Status:        fmt.Sprintf("%d %s", status, http.StatusText(status)),
		Header:        http.Header{"Content-Type": {"text/plain; charset=utf-8"}},
		Body:          io.NopCloser(strings.NewReader(body)),
		ContentLength: int64(len(body)),
	}
}

// beginWebRequest keeps the request attached to its current identity until the
// handler has finished, including any synchronous LocalAPI mutation.
func (h *Host) beginWebRequest(w http.ResponseWriter, r *http.Request) (*http.Request, func(), bool) {
	h.webMu.Lock()
	defer h.webMu.Unlock()
	if h.webChanging {
		return r, nil, false
	}
	requestCtx := r.Context()
	readOnly := r.Method == http.MethodGet || r.Method == http.MethodHead
	if !readOnly {
		// An I/O deadline or disconnect also cancels the connection context.
		// Preserve mutation completion even then: canceling LocalAPI early
		// could let it keep writing after this handler has left the gate.
		requestCtx = context.WithoutCancel(requestCtx)
	}
	ctx, cancel := context.WithCancel(requestCtx)
	r = r.WithContext(ctx)
	controller := http.NewResponseController(w)
	if h.webActive == nil {
		h.webActive = make(map[*http.Request]func())
	}
	h.webActive[r] = func() {
		// Auth waits can block indefinitely. Cancel read-only requests, but
		// let an already submitted mutation finish before changing identity.
		if readOnly {
			cancel()
		}
		// Context cancellation alone cannot interrupt a stalled request body
		// or response write. Deadlines unblock the HTTP connection's I/O.
		controller.SetReadDeadline(time.Now())
		controller.SetWriteDeadline(time.Now())
	}
	h.webRequests.Add(1)
	return r, func() {
		cancel()
		h.webMu.Lock()
		delete(h.webActive, r)
		controller.SetReadDeadline(time.Time{})
		controller.SetWriteDeadline(time.Time{})
		h.webMu.Unlock()
		h.webRequests.Done()
	}, true
}

// beginWebSessionChange is called while commandMu serializes native commands,
// web logout, and shutdown. It stops admission, interrupts slow clients, and
// drains handlers before changing identity. The returned function reopens
// admission after the entire transition.
func (h *Host) beginWebSessionChange() func() {
	h.webMu.Lock()
	h.webChanging = true
	for _, interrupt := range h.webActive {
		interrupt()
	}
	h.webMu.Unlock()
	h.webRequests.Wait()
	return func() {
		h.webMu.Lock()
		h.webChanging = false
		h.webMu.Unlock()
	}
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
		LocalClient: newWebLocalClient(lc),
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
	if src == 0 {
		return nil, fmt.Errorf("Tailscale web client source identity is unavailable")
	}
	if !h.isCurrentSession(lc, generation) {
		return nil, fmt.Errorf("Tailscale web client session changed")
	}
	status, err := lc.StatusWithoutPeers(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to read the local Tailscale identity: %w", err)
	}
	if status.Self == nil || status.Self.NodeID == 0 {
		return nil, fmt.Errorf("local Tailscale identity is unavailable")
	}
	if !h.isCurrentSession(lc, generation) {
		return nil, fmt.Errorf("Tailscale web client session changed")
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
