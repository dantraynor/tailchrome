package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
)

const (
	defaultControlURLOrigin = "https://controlplane.tailscale.com"
	defaultLoginURLOrigin   = "https://login.tailscale.com"
)

var validInitID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// Host manages the native messaging connection and the Tailscale tsnet instance.
type Host struct {
	stdin  io.Reader
	stdout io.Writer

	mu sync.Mutex // protects writes to stdout

	// sessionMu protects the active tsnet server, local client, watcher, and
	// browser profile identity as one atomic session.
	sessionMu         sync.RWMutex
	sessionGeneration uint64

	// ts is the tsnet.Server, created during init.
	ts *tsnet.Server
	// lc is the local client for the tsnet.Server.
	lc *local.Client

	// initID is the browser profile UUID, set during the init command.
	initID string

	// watchCancel cancels the IPN bus watcher goroutine.
	watchCancel context.CancelFunc

	// correctionCancel stops the async retries of the startup
	// WantRunning=false correction. Only touched from the dispatch goroutine;
	// an explicit run-state command cancels it first so a stale retry can
	// never override what the user just asked for.
	correctionCancel context.CancelFunc
	correctionDone   <-chan struct{}

	// Cached state for building status updates.
	stateMu         sync.Mutex
	lastState       string
	lastBrowseToURL string
	lastPrefs       *PrefsView
	lastHealth      []string

	pendingMu        sync.Mutex
	pendingTransfers map[string]*fileTransferAccumulator
	activeMu         sync.Mutex
	activeTransfers  map[uint64]context.CancelFunc
	nextTransferID   uint64

	webMu    sync.Mutex
	webCache *webServerCache

	// proxyDial is a test seam; production leaves it nil and uses tsnet.
	proxyDial func(context.Context, string, string) (net.Conn, error)
}

// newHost creates a new Host that reads from r and writes to w.
func newHost(r io.Reader, w io.Writer) *Host {
	return &Host{
		stdin:  r,
		stdout: w,
	}
}

// readMessages reads native messaging protocol messages from stdin in a loop.
// Each message is a 4-byte little-endian length prefix followed by a JSON payload.
func (h *Host) readMessages() {
	for {
		// Read the 4-byte length prefix.
		var length uint32
		if err := binary.Read(h.stdin, binary.LittleEndian, &length); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				log.Println("stdin closed, exiting")
				return
			}
			log.Printf("failed to read message length: %v", err)
			return
		}

		if length == 0 {
			continue
		}
		if length > maxMessageSize {
			log.Printf("message too large: %d bytes", length)
			if _, err := io.CopyN(io.Discard, h.stdin, int64(length)); err != nil {
				log.Printf("failed to drain oversized message: %v", err)
				return
			}
			h.sendError("", fmt.Sprintf("message too large: %d bytes", length))
			continue
		}

		// Read the JSON payload.
		buf := make([]byte, length)
		if _, err := io.ReadFull(h.stdin, buf); err != nil {
			log.Printf("failed to read message body: %v", err)
			return
		}

		var req Request
		if err := json.Unmarshal(buf, &req); err != nil {
			log.Printf("failed to unmarshal request: %v", err)
			h.sendError("", fmt.Sprintf("invalid JSON: %v", err))
			continue
		}

		h.handleRequest(req)
	}
}

// send writes a Reply to stdout using the native messaging wire format.
// It is safe for concurrent use.
func (h *Host) send(reply Reply) {
	data, err := json.Marshal(reply)
	if err != nil {
		log.Printf("failed to marshal reply: %v", err)
		return
	}

	if len(data) > maxMessageSize && reply.Status != nil {
		data, err = truncateStatusReply(reply)
		if err != nil {
			log.Printf("failed to truncate status reply: %v", err)
			return
		}
	}

	if len(data) > maxMessageSize {
		log.Printf("reply too large (%d bytes), dropping", len(data))
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	if err := binary.Write(h.stdout, binary.LittleEndian, uint32(len(data))); err != nil {
		log.Printf("failed to write reply length: %v", err)
		return
	}
	if _, err := h.stdout.Write(data); err != nil {
		log.Printf("failed to write reply body: %v", err)
		return
	}
}

// truncateStatusReply removes peers from the end until a status reply fits the
// browser's native-messaging limit, while explicitly reporting the omission.
func truncateStatusReply(reply Reply) ([]byte, error) {
	status := *reply.Status
	status.Peers = append([]PeerInfo(nil), reply.Status.Peers...)
	status.TotalPeers = len(status.Peers)
	status.PeersTruncated = true
	reply.Status = &status

	for {
		data, err := json.Marshal(reply)
		if err != nil {
			return nil, err
		}
		if len(data) <= maxMessageSize || len(status.Peers) == 0 {
			return data, nil
		}
		// Remove multiple peers per pass for large tailnets, then finish one at
		// a time near the boundary.
		remove := len(status.Peers) / 8
		if remove < 1 {
			remove = 1
		}
		status.Peers = status.Peers[:len(status.Peers)-remove]
	}
}

// sendError sends an error reply for a given command.
func (h *Host) sendError(cmd, message string) {
	h.send(Reply{
		Cmd: "error",
		Error: &ErrorReply{
			Cmd:     cmd,
			Message: message,
		},
	})
}

func (h *Host) clearCachedStatus(prefs *ipn.Prefs) {
	h.stateMu.Lock()
	defer h.stateMu.Unlock()
	h.lastState = ""
	h.lastBrowseToURL = ""
	h.lastPrefs = nil
	h.lastHealth = nil
	if prefs != nil {
		h.lastPrefs = prefsViewFromIPN(prefs.View())
	}
}

func controlURLForPrefs(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if isDefaultControlURL(trimmed) {
		return ""
	}
	return trimmed
}

// isValidControlURL reports whether a non-empty custom control URL is a
// well-formed http/https URL with a host. Validation lives here at the trust
// boundary (not only in the popup) so any caller of set-prefs is guarded.
func isValidControlURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	scheme := strings.ToLower(u.Scheme)
	return (scheme == "http" || scheme == "https") && u.Host != ""
}

func controlURLCompareKey(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if isDefaultControlURL(trimmed) {
		return ""
	}

	u, err := url.Parse(trimmed)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return trimmed
	}

	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = normalizedURLHost(u)
	if u.Path == "/" && u.RawQuery == "" {
		u.Path = ""
	}
	u.Fragment = ""
	return u.String()
}

func isDefaultControlURL(raw string) bool {
	if raw == "" {
		return true
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return false
	}
	switch normalizedURLOrigin(u) {
	case defaultControlURLOrigin, defaultLoginURLOrigin:
		return true
	default:
		return false
	}
}

func normalizedURLOrigin(u *url.URL) string {
	scheme := strings.ToLower(u.Scheme)
	host := normalizedURLHost(u)
	return scheme + "://" + host
}

func normalizedURLHost(u *url.URL) string {
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if port == "" || (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		return host
	}
	// JoinHostPort re-adds brackets for IPv6 literals so distinct hosts don't
	// collapse to the same key (e.g. "[::1]:8443" vs "::1:8443").
	return net.JoinHostPort(host, port)
}

// handleRequest dispatches a request to the appropriate handler based on the cmd field.
func (h *Host) handleRequest(req Request) {
	switch req.Cmd {
	case "init":
		h.handleInit(req)
	case "login":
		h.handleLogin()
	case "up":
		h.handleUp()
	case "down":
		h.handleDown()
	case "get-status":
		h.handleGetStatus()
	case "ping":
		h.handlePing()
	case "ping-peer":
		h.handlePingPeer(req)
	case "bug-report":
		h.handleBugReport(req)
	case "netcheck":
		h.handleNetcheck()
	case "set-exit-node":
		h.handleSetExitNode(req.NodeID)
	case "set-prefs":
		h.handleSetPrefs(req)
	case "list-profiles":
		h.handleListProfiles()
	case "switch-profile":
		h.handleSwitchProfile(req.ProfileID)
	case "new-profile":
		h.handleNewProfile()
	case "delete-profile":
		h.handleDeleteProfile(req.ProfileID)
	case "send-file":
		h.handleSendFile(req)
	case "suggest-exit-node":
		h.handleSuggestExitNode()
	case "logout":
		h.handleLogout()
	default:
		h.sendError(req.Cmd, fmt.Sprintf("unknown command: %q", req.Cmd))
	}
}

// handleInit initializes (or reuses) a tsnet.Server for the given browser profile.
func (h *Host) handleInit(req Request) {
	if !validInitID.MatchString(req.InitID) {
		h.send(Reply{
			Cmd:  "init",
			Init: &InitReply{Error: "initID must contain 1-64 letters, numbers, underscores, or hyphens"},
		})
		return
	}

	// If already initialized with the same ID, reuse.
	h.sessionMu.RLock()
	sameSession := h.ts != nil && h.initID == req.InitID
	h.sessionMu.RUnlock()
	if sameSession {
		h.send(Reply{
			Cmd:  "init",
			Init: &InitReply{},
		})
		return
	}

	// Atomically detach the old session before closing it so proxy and status
	// goroutines never race against partially replaced fields.
	h.sessionMu.Lock()
	oldServer := h.ts
	oldWatchCancel := h.watchCancel
	h.ts = nil
	h.lc = nil
	h.watchCancel = nil
	h.initID = req.InitID
	h.sessionGeneration++
	generation := h.sessionGeneration
	h.sessionMu.Unlock()

	h.cancelStartupCorrection()
	if oldWatchCancel != nil {
		oldWatchCancel()
	}
	if oldServer != nil {
		oldServer.Close()
	}
	h.cancelTransfers()
	h.clearCachedStatus(nil)

	homeDir, err := os.UserHomeDir()
	if err != nil {
		h.send(Reply{
			Cmd:  "init",
			Init: &InitReply{Error: fmt.Sprintf("failed to get home dir: %v", err)},
		})
		return
	}

	stateDir := filepath.Join(homeDir, ".config", "tailscale-browser-ext", req.InitID)
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		h.send(Reply{
			Cmd:  "init",
			Init: &InitReply{Error: fmt.Sprintf("failed to create state dir: %v", err)},
		})
		return
	}

	server := &tsnet.Server{
		Dir:          stateDir,
		Hostname:     "browser-ext",
		RunWebClient: true,
		Logf:         log.Printf,
	}

	if err := server.Start(); err != nil {
		h.send(Reply{
			Cmd:  "init",
			Init: &InitReply{Error: fmt.Sprintf("failed to start tsnet: %v", err)},
		})
		return
	}

	lc, err := server.LocalClient()
	if err != nil {
		h.send(Reply{
			Cmd:  "init",
			Init: &InitReply{Error: fmt.Sprintf("failed to get local client: %v", err)},
		})
		server.Close()
		return
	}

	// tsnet.Start always applies WantRunning=true, bringing the node up on
	// every host launch. When the extension asked for a stopped start
	// (auto-connect off, or the user had disconnected), counteract it before
	// the connection establishes (#90). Run the correction asynchronously so
	// init never stalls the sole reader of native-messaging frames. An explicit
	// run-state command stops future retries and briefly waits for any
	// in-flight edit so a stale `false` can't slip in behind the newer
	// decision; the wait is bounded (see cancelStartupCorrection) because a
	// wedged local API must never freeze dispatch outright.
	if req.WantRunning != nil && !*req.WantRunning {
		h.startWantRunningFalseCorrection(lc)
	}

	// Start watching the IPN bus for state changes with a cancellable context.
	watchCtx, watchCancel := context.WithCancel(context.Background())
	h.sessionMu.Lock()
	if h.sessionGeneration != generation || h.initID != req.InitID {
		h.sessionMu.Unlock()
		watchCancel()
		server.Close()
		return
	}
	h.ts = server
	h.lc = lc
	h.watchCancel = watchCancel
	h.sessionMu.Unlock()
	go h.watchIPNBus(watchCtx, lc, generation)

	h.send(Reply{
		Cmd:  "init",
		Init: &InitReply{},
	})
}

// applyWantRunningFalse issues a single EditPrefs(WantRunning=false) bounded
// by a 10s timeout so the correction goroutine always terminates and `done`
// always closes, even against a wedged local API.
func (h *Host) applyWantRunningFalse(ctx context.Context, lc *local.Client) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err := lc.EditPrefs(ctx, &ipn.MaskedPrefs{
		Prefs: ipn.Prefs{
			WantRunning: false,
		},
		WantRunningSet: true,
	})
	return err
}

// startWantRunningFalseCorrection applies and, on failure, retries the startup
// correction off the dispatch goroutine.
func (h *Host) startWantRunningFalseCorrection(lc *local.Client) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	h.correctionCancel = cancel
	h.correctionDone = done
	go func() {
		defer cancel()
		defer close(done)
		for attempt := 1; attempt <= 3; attempt++ {
			if attempt > 1 {
				select {
				case <-ctx.Done():
					return
				case <-time.After(500 * time.Millisecond):
				}
			}
			err := h.applyWantRunningFalse(ctx, lc)
			if err == nil || ctx.Err() != nil {
				return
			}
			log.Printf("init: failed to apply wantRunning=false (attempt %d/3): %v", attempt, err)
		}
	}()
}

// correctionCancelGrace bounds how long an explicit run-state command waits
// for an in-flight startup correction to finish. Overridden in tests.
var correctionCancelGrace = 2 * time.Second

// cancelStartupCorrection stops any pending startup-correction retries. Must
// run before an explicit run-state change is applied, on the same dispatch
// goroutine that started the retries.
//
// Stopping future retries alone does not establish ordering with an EditPrefs
// call already in flight — localapi may keep processing a decoded request
// after its client context is canceled — so wait briefly for the worker to
// finish before issuing the explicit command. The wait is bounded: this runs
// on the sole native-messaging dispatch goroutine, and blocking it forever on
// a wedged local API would freeze every subsequent command with no recovery
// path (the extension only reconnects on port death). In the worst case a
// stale WantRunning=false lands after the user's `up`; that surfaces as a
// visible Stopped state the user can re-toggle — recoverable, unlike a hang.
func (h *Host) cancelStartupCorrection() {
	cancel := h.correctionCancel
	done := h.correctionDone
	h.correctionCancel = nil
	h.correctionDone = nil
	if cancel == nil {
		return
	}
	cancel()
	if done != nil {
		select {
		case <-done:
		case <-time.After(correctionCancelGrace):
			log.Printf("startup correction still in flight after %v; proceeding", correctionCancelGrace)
		}
	}
}

// handleLogin requests or resumes an interactive Tailscale login flow.
func (h *Host) handleLogin() {
	lc := h.localClient("login")
	if lc == nil {
		return
	}

	h.cancelStartupCorrection()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := lc.StartLoginInteractive(ctx); err != nil {
		h.sendError("login", fmt.Sprintf("failed to start login: %v", err))
	}
}

// handleUp sets WantRunning=true to bring Tailscale up.
func (h *Host) handleUp() {
	lc := h.localClient("up")
	if lc == nil {
		return
	}

	h.cancelStartupCorrection()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err := lc.EditPrefs(ctx, &ipn.MaskedPrefs{
		Prefs: ipn.Prefs{
			WantRunning: true,
		},
		WantRunningSet: true,
	})
	if err != nil {
		h.sendError("up", fmt.Sprintf("failed to bring up: %v", err))
		return
	}

	h.handleGetStatus()
}

// handleDown sets WantRunning=false to bring Tailscale down.
func (h *Host) handleDown() {
	lc := h.localClient("down")
	if lc == nil {
		return
	}

	h.cancelStartupCorrection()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err := lc.EditPrefs(ctx, &ipn.MaskedPrefs{
		Prefs: ipn.Prefs{
			WantRunning: false,
		},
		WantRunningSet: true,
	})
	if err != nil {
		h.sendError("down", fmt.Sprintf("failed to bring down: %v", err))
		return
	}

	h.handleGetStatus()
}

// handleGetStatus fetches the current status and sends it to the extension.
func (h *Host) handleGetStatus() {
	if err := h.requireInit("get-status"); err != nil {
		return
	}

	status, err := h.refreshFullStatus()
	if err != nil {
		h.sendError("get-status", fmt.Sprintf("failed to get status: %v", err))
		return
	}

	h.send(Reply{
		Cmd:    "status",
		Status: status,
	})
}

// handlePing sends a pong reply.
func (h *Host) handlePing() {
	h.send(Reply{
		Cmd:  "pong",
		Pong: &PongReply{},
	})
}

func (h *Host) handlePingPeer(req Request) {
	lc := h.localClient("ping-peer")
	if lc == nil {
		return
	}
	if req.NodeID == "" {
		h.sendError("ping-peer", "nodeID is required")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	st, err := lc.Status(ctx)
	if err != nil {
		h.sendError("ping-peer", fmt.Sprintf("failed to get status: %v", err))
		return
	}
	var ps *ipnstate.PeerStatus
	if st.Self != nil && string(st.Self.ID) == req.NodeID {
		ps = st.Self
	} else {
		for _, p := range st.Peer {
			if string(p.ID) == req.NodeID {
				ps = p
				break
			}
		}
	}
	if ps == nil {
		h.sendError("ping-peer", fmt.Sprintf("no peer with id %q", req.NodeID))
		return
	}
	if len(ps.TailscaleIPs) == 0 {
		h.sendError("ping-peer", "peer has no Tailscale IPs")
		return
	}
	ip := ps.TailscaleIPs[0]
	res, err := lc.Ping(ctx, ip, tailcfg.PingDisco)
	if err != nil {
		h.send(Reply{
			Cmd: "ping-peer",
			Diagnostic: &DiagnosticReply{
				Title: "Ping failed",
				Body:  err.Error(),
			},
		})
		return
	}
	var b strings.Builder
	if res.Err != "" {
		fmt.Fprintf(&b, "Error: %s\n", res.Err)
	}
	fmt.Fprintf(&b, "IP: %s\n", res.IP)
	if res.NodeName != "" {
		fmt.Fprintf(&b, "Node: %s\n", res.NodeName)
	}
	if res.LatencySeconds > 0 {
		fmt.Fprintf(&b, "Latency: %v\n", time.Duration(res.LatencySeconds*float64(time.Second)))
	}
	if res.Endpoint != "" {
		fmt.Fprintf(&b, "Endpoint: %s\n", res.Endpoint)
	}
	if res.DERPRegionCode != "" {
		fmt.Fprintf(&b, "DERP: %s\n", res.DERPRegionCode)
	}
	title := "Ping"
	if res.Err != "" {
		title = "Ping (with errors)"
	}
	h.send(Reply{
		Cmd: "ping-peer",
		Diagnostic: &DiagnosticReply{
			Title: title,
			Body:  strings.TrimSpace(b.String()),
		},
	})
}

func (h *Host) handleBugReport(req Request) {
	lc := h.localClient("bug-report")
	if lc == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	marker, err := lc.BugReport(ctx, req.Note)
	if err != nil {
		h.sendError("bug-report", fmt.Sprintf("bug-report failed: %v", err))
		return
	}
	h.send(Reply{
		Cmd: "bug-report",
		Diagnostic: &DiagnosticReply{
			Title: "Bug report",
			Body:  marker,
		},
	})
}

func (h *Host) handleNetcheck() {
	if h.localClient("netcheck") == nil {
		return
	}
	h.send(Reply{
		Cmd: "netcheck",
		Diagnostic: &DiagnosticReply{
			Title: "Netcheck",
			Body:  "Netcheck is not available in the browser helper; use the Tailscale CLI on a full install.",
		},
	})
}

type partialPrefsUpdate struct {
	ControlURL             *string   `json:"controlURL,omitempty"`
	ExitNodeID             *string   `json:"exitNodeID,omitempty"`
	ExitNodeAllowLANAccess *bool     `json:"exitNodeAllowLANAccess,omitempty"`
	CorpDNS                *bool     `json:"corpDNS,omitempty"`
	RouteAll               *bool     `json:"routeAll,omitempty"`
	ShieldsUp              *bool     `json:"shieldsUp,omitempty"`
	WantRunning            *bool     `json:"wantRunning,omitempty"`
	RunSSH                 *bool     `json:"runSSH,omitempty"`
	Hostname               *string   `json:"hostname,omitempty"`
	AdvertiseExitNode      *bool     `json:"advertiseExitNode,omitempty"`
	AdvertiseRoutes        *[]string `json:"advertiseRoutes,omitempty"`
}

func decodePartialPrefs(raw json.RawMessage) (partialPrefsUpdate, error) {
	var partial partialPrefsUpdate
	if err := json.Unmarshal(raw, &partial); err != nil {
		return partial, fmt.Errorf("invalid prefs JSON: %w", err)
	}
	return partial, nil
}

func (p partialPrefsUpdate) needsCurrentPrefs() bool {
	return p.AdvertiseRoutes != nil || p.AdvertiseExitNode != nil || p.ControlURL != nil
}

// maskedPrefsForUpdate converts a decoded browser update into the Tailscale
// masked-prefs representation without mutating the current preference snapshot.
func maskedPrefsForUpdate(partial partialPrefsUpdate, currentPrefs *ipn.Prefs) (*ipn.MaskedPrefs, bool, error) {
	mp := &ipn.MaskedPrefs{}
	if partial.ControlURL != nil {
		normalized := controlURLForPrefs(*partial.ControlURL)
		if normalized != "" && !isValidControlURL(normalized) {
			return nil, false, fmt.Errorf("invalid control server URL: %q", normalized)
		}
		mp.ControlURLSet = true
		mp.Prefs.ControlURL = normalized
	}
	if partial.ExitNodeID != nil {
		mp.ExitNodeIDSet = true
		mp.Prefs.ExitNodeID = tailcfg.StableNodeID(*partial.ExitNodeID)
	}
	if partial.ExitNodeAllowLANAccess != nil {
		mp.ExitNodeAllowLANAccessSet = true
		mp.Prefs.ExitNodeAllowLANAccess = *partial.ExitNodeAllowLANAccess
	}
	if partial.CorpDNS != nil {
		mp.CorpDNSSet = true
		mp.Prefs.CorpDNS = *partial.CorpDNS
	}
	if partial.RouteAll != nil {
		mp.RouteAllSet = true
		mp.Prefs.RouteAll = *partial.RouteAll
	}
	if partial.ShieldsUp != nil {
		mp.ShieldsUpSet = true
		mp.Prefs.ShieldsUp = *partial.ShieldsUp
	}
	if partial.WantRunning != nil {
		mp.WantRunningSet = true
		mp.Prefs.WantRunning = *partial.WantRunning
	}
	if partial.RunSSH != nil {
		mp.RunSSHSet = true
		mp.Prefs.RunSSH = *partial.RunSSH
	}
	if partial.Hostname != nil {
		mp.HostnameSet = true
		mp.Prefs.Hostname = *partial.Hostname
	}

	if partial.needsCurrentPrefs() && currentPrefs == nil {
		return nil, false, fmt.Errorf("current prefs are required for this update")
	}
	if partial.AdvertiseRoutes != nil || partial.AdvertiseExitNode != nil {
		routes := append([]netip.Prefix(nil), currentPrefs.AdvertiseRoutes...)
		exitWas := currentPrefs.AdvertisesExitNode()
		if partial.AdvertiseRoutes != nil {
			routes = make([]netip.Prefix, 0, len(*partial.AdvertiseRoutes))
			for _, route := range *partial.AdvertiseRoutes {
				prefix, err := netip.ParsePrefix(route)
				if err != nil {
					return nil, false, fmt.Errorf("invalid advertise route CIDR %q: %w", route, err)
				}
				routes = append(routes, prefix)
			}
		}

		advertiseExitNode := exitWas
		if partial.AdvertiseExitNode != nil {
			advertiseExitNode = *partial.AdvertiseExitNode
		}
		updated := *currentPrefs
		updated.AdvertiseRoutes = routes
		updated.SetAdvertiseExitNode(advertiseExitNode)
		mp.AdvertiseRoutesSet = true
		mp.Prefs.AdvertiseRoutes = append([]netip.Prefix(nil), updated.AdvertiseRoutes...)
	}

	controlURLChanged := partial.ControlURL != nil &&
		controlURLCompareKey(mp.Prefs.ControlURL) != controlURLCompareKey(currentPrefs.ControlURL)
	return mp, controlURLChanged, nil
}

// handleSetPrefs applies partial preference changes.
func (h *Host) handleSetPrefs(req Request) {
	lc := h.localClient("set-prefs")
	if lc == nil {
		return
	}

	if req.Prefs == nil {
		h.sendError("set-prefs", "prefs field is required")
		return
	}

	partial, err := decodePartialPrefs(req.Prefs)
	if err != nil {
		h.sendError("set-prefs", err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Fetch current prefs when we need to merge against them (route advertise) or
	// detect a real ControlURL change. Reuse the single GetPrefs call.
	var currentPrefs *ipn.Prefs
	if partial.needsCurrentPrefs() {
		cp, err := lc.GetPrefs(ctx)
		if err != nil {
			h.sendError("set-prefs", fmt.Sprintf("failed to get current prefs: %v", err))
			return
		}
		currentPrefs = cp
	}

	mp, controlURLChanged, err := maskedPrefsForUpdate(partial, currentPrefs)
	if err != nil {
		h.sendError("set-prefs", err.Error())
		return
	}

	if partial.WantRunning != nil {
		h.cancelStartupCorrection()
	}

	updatedPrefs, err := lc.EditPrefs(ctx, mp)
	if err != nil {
		h.sendError("set-prefs", fmt.Sprintf("failed to set prefs: %v", err))
		return
	}

	if controlURLChanged {
		// Exit-node selection and node identity are scoped to the previous
		// tailnet; clear them so a now-invalid ExitNodeID (a StableNodeID from
		// the old control server) isn't carried onto the new one.
		updatedPrefs.ExitNodeID = ""
		updatedPrefs.ExitNodeIP = netip.Addr{}

		h.clearCachedStatus(updatedPrefs)

		// Explicitly log out so the previous control plane's node key and
		// profile identity are discarded. Without this, restarting with the
		// new ControlURL would carry the old identity to the new server and
		// the IPN engine could skip the interactive login prompt.
		logoutCtx, logoutCancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := lc.Logout(logoutCtx); err != nil {
			logoutCancel()
			log.Printf("logout during controlURL change failed, restoring previous URL: %v", err)

			rollbackCtx, rollbackCancel := context.WithTimeout(context.Background(), 30*time.Second)
			rollbackErr := lc.Start(rollbackCtx, ipn.Options{UpdatePrefs: currentPrefs})
			rollbackCancel()
			if rollbackErr != nil {
				h.clearCachedStatus(currentPrefs)
				h.sendError("set-prefs", fmt.Sprintf("failed to logout before changing control URL: %v; also failed to restore previous control URL: %v", err, rollbackErr))
				return
			}

			h.clearCachedStatus(currentPrefs)
			h.handleGetStatus()
			h.sendError("set-prefs", fmt.Sprintf("failed to logout before changing control URL: %v; restored previous control URL", err))
			return
		}
		logoutCancel()

		restartCtx, restartCancel := context.WithTimeout(context.Background(), 30*time.Second)
		if err := lc.Start(restartCtx, ipn.Options{UpdatePrefs: updatedPrefs}); err != nil {
			restartCancel()
			log.Printf("restart with updated control URL failed, restoring previous URL: %v", err)

			rollbackCtx, rollbackCancel := context.WithTimeout(context.Background(), 30*time.Second)
			rollbackErr := lc.Start(rollbackCtx, ipn.Options{UpdatePrefs: currentPrefs})
			rollbackCancel()
			if rollbackErr != nil {
				h.clearCachedStatus(currentPrefs)
				h.sendError("set-prefs", fmt.Sprintf("failed to restart with updated control URL: %v; also failed to restore previous control URL: %v", err, rollbackErr))
				return
			}

			h.clearCachedStatus(currentPrefs)
			h.handleGetStatus()
			// The logout above already discarded the previous session, so the
			// prefs are restored but the node is signed out and must log in again.
			h.sendError("set-prefs", fmt.Sprintf("failed to switch control server: %v; reverted to your previous server, but you have been signed out and must log in again", err))
			return
		}
		restartCancel()
	}

	h.handleGetStatus()
}

// handleLogout logs out of the current Tailscale account.
func (h *Host) handleLogout() {
	lc := h.localClient("logout")
	if lc == nil {
		return
	}

	h.cancelStartupCorrection()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := lc.Logout(ctx); err != nil {
		h.sendError("logout", fmt.Sprintf("failed to logout: %v", err))
		return
	}
}

// requireInit checks that the host has been initialized and sends an error if not.
// Returns nil if initialized, an error otherwise.
func (h *Host) requireInit(cmd string) error {
	h.sessionMu.RLock()
	lc := h.lc
	h.sessionMu.RUnlock()
	if lc == nil {
		h.sendError(cmd, "host not initialized; send init command first")
		return fmt.Errorf("not initialized")
	}
	return nil
}

func (h *Host) localClient(cmd string) *local.Client {
	h.sessionMu.RLock()
	lc := h.lc
	h.sessionMu.RUnlock()
	if lc == nil {
		h.sendError(cmd, "host not initialized; send init command first")
	}
	return lc
}

func (h *Host) sessionSnapshot() (*tsnet.Server, *local.Client, uint64) {
	h.sessionMu.RLock()
	defer h.sessionMu.RUnlock()
	return h.ts, h.lc, h.sessionGeneration
}

func (h *Host) isCurrentSession(lc *local.Client, generation uint64) bool {
	h.sessionMu.RLock()
	defer h.sessionMu.RUnlock()
	return h.lc == lc && h.sessionGeneration == generation
}

func (h *Host) shutdownSession() {
	h.sessionMu.Lock()
	server := h.ts
	cancelWatch := h.watchCancel
	h.ts = nil
	h.lc = nil
	h.watchCancel = nil
	h.sessionGeneration++
	h.sessionMu.Unlock()

	if cancelWatch != nil {
		cancelWatch()
	}
	if server != nil {
		server.Close()
	}
	h.cancelTransfers()
}
