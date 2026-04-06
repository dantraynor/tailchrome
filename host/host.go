package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
)

// Host manages the native messaging connection and the Tailscale tsnet instance.
type Host struct {
	stdin  io.Reader
	stdout io.Writer

	mu sync.Mutex // protects writes to stdout

	// ts is the tsnet.Server, created during init.
	ts *tsnet.Server
	// lc is the local client for the tsnet.Server.
	lc *local.Client

	// initID is the browser profile UUID, set during the init command.
	initID string

	// watchCancel cancels the IPN bus watcher goroutine.
	watchCancel context.CancelFunc

	// Cached state for building status updates.
	stateMu         sync.Mutex
	lastState       string
	lastBrowseToURL string
	lastPrefs       *PrefsView
	lastHealth      []string
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
			if err == io.EOF {
				log.Println("stdin closed, exiting")
				os.Exit(0)
			}
			log.Fatalf("failed to read message length: %v", err)
		}

		if length == 0 {
			continue
		}
		if length > maxMessageSize {
			log.Printf("message too large: %d bytes", length)
			continue
		}

		// Read the JSON payload.
		buf := make([]byte, length)
		if _, err := io.ReadFull(h.stdin, buf); err != nil {
			log.Fatalf("failed to read message body: %v", err)
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

// handleRequest dispatches a request to the appropriate handler based on the cmd field.
func (h *Host) handleRequest(req Request) {
	switch req.Cmd {
	case "init":
		h.handleInit(req)
	case "up":
		h.handleUp()
	case "down":
		h.handleDown()
	case "get-status":
		h.handleGetStatus()
	case "ping":
		h.handlePing()
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
	if req.InitID == "" {
		h.send(Reply{
			Cmd:  "init",
			Init: &InitReply{Error: "initID is required"},
		})
		return
	}

	// If already initialized with the same ID, reuse.
	if h.ts != nil && h.initID == req.InitID {
		h.send(Reply{
			Cmd:  "init",
			Init: &InitReply{},
		})
		return
	}

	// If initialized with a different ID, cancel watcher and close the old server.
	if h.ts != nil {
		if h.watchCancel != nil {
			h.watchCancel()
			h.watchCancel = nil
		}
		h.ts.Close()
		h.ts = nil
		h.lc = nil
	}

	h.initID = req.InitID

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

	h.ts = &tsnet.Server{
		Dir:          stateDir,
		Hostname:     "browser-ext",
		RunWebClient: true,
		Logf:         log.Printf,
	}

	if err := h.ts.Start(); err != nil {
		h.send(Reply{
			Cmd:  "init",
			Init: &InitReply{Error: fmt.Sprintf("failed to start tsnet: %v", err)},
		})
		h.ts = nil
		return
	}

	lc, err := h.ts.LocalClient()
	if err != nil {
		h.send(Reply{
			Cmd:  "init",
			Init: &InitReply{Error: fmt.Sprintf("failed to get local client: %v", err)},
		})
		h.ts.Close()
		h.ts = nil
		return
	}
	h.lc = lc

	// Start watching the IPN bus for state changes with a cancellable context.
	watchCtx, watchCancel := context.WithCancel(context.Background())
	h.watchCancel = watchCancel
	go h.watchIPNBus(watchCtx)

	h.send(Reply{
		Cmd:  "init",
		Init: &InitReply{},
	})
}

// handleUp sets WantRunning=true to bring Tailscale up.
func (h *Host) handleUp() {
	if err := h.requireInit("up"); err != nil {
		return
	}

	ctx := context.Background()
	_, err := h.lc.EditPrefs(ctx, &ipn.MaskedPrefs{
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
	if err := h.requireInit("down"); err != nil {
		return
	}

	ctx := context.Background()
	_, err := h.lc.EditPrefs(ctx, &ipn.MaskedPrefs{
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

// handleSetPrefs applies partial preference changes.
func (h *Host) handleSetPrefs(req Request) {
	if err := h.requireInit("set-prefs"); err != nil {
		return
	}

	if req.Prefs == nil {
		h.sendError("set-prefs", "prefs field is required")
		return
	}

	// Decode the partial prefs from the extension.
	var partial struct {
		ExitNodeID             *string `json:"exitNodeID,omitempty"`
		ExitNodeAllowLANAccess *bool   `json:"exitNodeAllowLANAccess,omitempty"`
		CorpDNS                *bool   `json:"corpDNS,omitempty"`
		RouteAll               *bool   `json:"routeAll,omitempty"`
		ShieldsUp              *bool   `json:"shieldsUp,omitempty"`
		WantRunning            *bool   `json:"wantRunning,omitempty"`
		RunSSH                 *bool   `json:"runSSH,omitempty"`
		Hostname               *string `json:"hostname,omitempty"`
		AdvertiseExitNode      *bool   `json:"advertiseExitNode,omitempty"`
	}
	if err := json.Unmarshal(req.Prefs, &partial); err != nil {
		h.sendError("set-prefs", fmt.Sprintf("invalid prefs JSON: %v", err))
		return
	}

	mp := &ipn.MaskedPrefs{}
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
	if partial.AdvertiseExitNode != nil {
		// Read current prefs to preserve any existing subnet routes.
		currentPrefs, err := h.lc.GetPrefs(context.Background())
		if err != nil {
			h.sendError("set-prefs", fmt.Sprintf("failed to get current prefs: %v", err))
			return
		}
		currentPrefs.SetAdvertiseExitNode(*partial.AdvertiseExitNode)
		mp.AdvertiseRoutesSet = true
		mp.Prefs.AdvertiseRoutes = currentPrefs.AdvertiseRoutes
	}

	ctx := context.Background()
	_, err := h.lc.EditPrefs(ctx, mp)
	if err != nil {
		h.sendError("set-prefs", fmt.Sprintf("failed to set prefs: %v", err))
		return
	}

	h.handleGetStatus()
}

// handleLogout logs out of the current Tailscale account.
func (h *Host) handleLogout() {
	if err := h.requireInit("logout"); err != nil {
		return
	}

	ctx := context.Background()
	if err := h.lc.Logout(ctx); err != nil {
		h.sendError("logout", fmt.Sprintf("failed to logout: %v", err))
		return
	}
}

// requireInit checks that the host has been initialized and sends an error if not.
// Returns nil if initialized, an error otherwise.
func (h *Host) requireInit(cmd string) error {
	if h.lc == nil {
		h.sendError(cmd, "host not initialized; send init command first")
		return fmt.Errorf("not initialized")
	}
	return nil
}
