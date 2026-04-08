package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"strings"

	"tailscale.com/client/web"
	"tailscale.com/net/proxymux"
	"tailscale.com/net/socks5"
)

// startProxy starts an HTTP+SOCKS5 proxy on 127.0.0.1:0 and returns the port.
// The proxy uses the tsnet.Server's Dial method to route connections through the tailnet.
func (h *Host) startProxy() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("failed to listen: %w", err)
	}

	port := ln.Addr().(*net.TCPAddr).Port

	// Split the listener into SOCKS5 and HTTP listeners.
	socksLn, httpLn := proxymux.SplitSOCKSAndHTTP(ln)

	// Start the SOCKS5 proxy.
	socksServer := &socks5.Server{
		Logf:   log.Printf,
		Dialer: h.tsnetDialer,
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
	if h.ts == nil {
		return nil, fmt.Errorf("tsnet server not initialized")
	}
	return h.ts.Dial(ctx, network, addr)
}

// serveHTTPProxy serves HTTP proxy requests, routing 100.100.100.100 to the
// Tailscale web client and everything else through the tailnet.
func (h *Host) serveHTTPProxy(ln net.Listener) error {
	// Create the web client server for handling requests to 100.100.100.100.
	var webServer *web.Server
	if h.lc != nil {
		var err error
		webServer, err = web.NewServer(web.ServerOpts{
			Mode:        web.ManageServerMode,
			LocalClient: h.lc,
			Logf:        log.Printf,
		})
		if err != nil {
			log.Printf("failed to create web server: %v", err)
			// Continue without web server; requests to 100.100.100.100 will fail.
		}
	}

	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			// No-op: we handle the request ourselves.
		},
		Transport: &http.Transport{
			DialContext: h.tsnetDialer,
		},
	}

	server := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			host := r.Host
			if h, _, err := net.SplitHostPort(host); err == nil {
				host = h
			}

			// Route requests to 100.100.100.100 to the web client.
			if host == "100.100.100.100" && webServer != nil {
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
		}),
	}

	return server.Serve(ln)
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
	client, _, err := hijacker.Hijack()
	if err != nil {
		log.Printf("failed to hijack connection: %v", err)
		return
	}
	defer client.Close()

	if _, err := fmt.Fprint(client, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		log.Printf("failed to write CONNECT response: %v", err)
		return
	}

	// Bidirectional copy. When one direction reaches EOF, half-close the
	// write side so the other direction can drain remaining bytes before
	// the deferred client.Close() tears down the full connection.
	done := make(chan struct{}, 2)
	go func() {
		io.Copy(upstream, client)
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
