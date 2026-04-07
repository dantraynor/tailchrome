package main

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
)

// watchIPNBus watches the IPN notification bus for state changes and sends
// status updates to the extension. It runs in its own goroutine.
func (h *Host) watchIPNBus(ctx context.Context) {
	watcher, err := h.lc.WatchIPNBus(ctx, ipn.NotifyInitialState|ipn.NotifyInitialPrefs|ipn.NotifyInitialNetMap)
	if err != nil {
		log.Printf("failed to watch IPN bus: %v", err)
		return
	}
	defer watcher.Close()

	// debounce coalesces rapid IPN notifications into a single status refresh.
	const debounceDuration = 150 * time.Millisecond
	var debounceTimer *time.Timer

	// sendDebounced schedules a status refresh after debounceDuration,
	// resetting any pending timer so only the last event in a burst fires.
	sendDebounced := func() {
		if debounceTimer != nil {
			debounceTimer.Reset(debounceDuration)
			return
		}
		debounceTimer = time.AfterFunc(debounceDuration, func() {
			status, err := h.refreshFullStatus()
			if err != nil {
				log.Printf("failed to refresh status after IPN bus change: %v", err)
				return
			}
			h.send(Reply{
				Cmd:    "status",
				Status: status,
			})
		})
	}

	for {
		select {
		case <-ctx.Done():
			log.Printf("IPN bus watcher cancelled")
			if debounceTimer != nil {
				debounceTimer.Stop()
			}
			return
		default:
		}

		n, err := watcher.Next()
		if err != nil {
			if ctx.Err() != nil {
				if debounceTimer != nil {
					debounceTimer.Stop()
				}
				return // cancelled
			}
			log.Printf("IPN bus watcher error: %v", err)
			return
		}

		changed := false

		if n.State != nil {
			h.stateMu.Lock()
			h.lastState = n.State.String()
			h.stateMu.Unlock()
			changed = true
		}

		if n.Prefs != nil && n.Prefs.Valid() {
			p := n.Prefs
			pv := &PrefsView{
				ControlURL:             p.ControlURL(),
				RouteAll:               p.RouteAll(),
				ExitNodeAllowLANAccess: p.ExitNodeAllowLANAccess(),
				CorpDNS:                p.CorpDNS(),
				WantRunning:            p.WantRunning(),
				ShieldsUp:              p.ShieldsUp(),
				Hostname:               p.Hostname(),
				RunSSH:                 p.RunSSH(),
				RunWebClient:           p.RunWebClient(),
				AdvertiseExitNode:      p.AdvertisesExitNode(),
			}
			if p.ExitNodeID() != "" {
				id := string(p.ExitNodeID())
				pv.ExitNodeID = id
			}
			h.stateMu.Lock()
			h.lastPrefs = pv
			h.stateMu.Unlock()
			changed = true
		}

		if n.BrowseToURL != nil {
			h.stateMu.Lock()
			h.lastBrowseToURL = *n.BrowseToURL
			h.stateMu.Unlock()
			changed = true
		}

		if n.NetMap != nil {
			changed = true
		}

		if n.Health != nil {
			var msgs []string
			for _, w := range n.Health.Warnings {
				// tsnet doesn't manage system DNS; suppress irrelevant warnings
				if strings.Contains(w.Text, "getting OS base config is not supported") {
					continue
				}
				msgs = append(msgs, w.Text)
			}
			h.stateMu.Lock()
			h.lastHealth = msgs
			h.stateMu.Unlock()
			changed = true
		}

		if changed {
			sendDebounced()
		}
	}
}

// refreshFullStatus calls the local client Status API and builds a full
// StatusUpdate from the enriched peer info plus cached IPN bus state.
func (h *Host) refreshFullStatus() (*StatusUpdate, error) {
	lc := h.lc // snapshot to avoid nil deref if handleInit tears down concurrently
	if lc == nil {
		return nil, fmt.Errorf("local client not initialized")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	st, err := lc.Status(ctx)
	if err != nil {
		return nil, err
	}

	return h.buildStatusUpdate(st), nil
}

// buildStatusUpdate constructs a StatusUpdate from the ipnstate.Status
// and the cached IPN bus state (lastState, lastPrefs, lastBrowseToURL, lastHealth).
func (h *Host) buildStatusUpdate(st *ipnstate.Status) *StatusUpdate {
	h.stateMu.Lock()
	state := h.lastState
	browseToURL := h.lastBrowseToURL
	prefs := h.lastPrefs
	health := h.lastHealth
	h.stateMu.Unlock()

	// Use the backend state from the status if we don't have one cached.
	if state == "" {
		state = st.BackendState
	}

	update := &StatusUpdate{
		BackendState: state,
		Running:      state == "Running",
		NeedsLogin:   state == "NeedsLogin" || state == "NeedsMachineAuth",
		BrowseToURL:  browseToURL,
		Prefs:        prefs,
		Health:       health,
		Peers:        []PeerInfo{},
	}

	if st.CurrentTailnet != nil {
		update.Tailnet = st.CurrentTailnet.Name
		update.MagicDNSSuffix = st.CurrentTailnet.MagicDNSSuffix
	}

	// Build self node info.
	if st.Self != nil {
		selfInfo := peerStatusToPeerInfo(st.Self, st)
		update.SelfNode = &selfInfo
	}

	// Build peer list and find the active exit node.
	peers := extractPeers(st)
	update.Peers = peers

	// Find the current exit node.
	for i := range peers {
		if peers[i].ExitNode {
			p := peers[i]
			update.ExitNode = &p
			break
		}
	}

	return update
}
