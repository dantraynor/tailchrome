package main

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
)

// watchIPNBus watches the IPN notification bus for state changes and sends
// status updates to the extension. It runs in its own goroutine.
func (h *Host) watchIPNBus(ctx context.Context, lc *local.Client, generation uint64) {
	backoff := time.Second
	for {
		err := h.watchIPNBusSession(ctx, lc, generation)
		if ctx.Err() != nil || !h.isCurrentSession(lc, generation) {
			return
		}
		log.Printf("IPN bus watcher error: %v; retrying in %v", err, backoff)
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if backoff < 30*time.Second {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
}

func (h *Host) watchIPNBusSession(ctx context.Context, lc *local.Client, generation uint64) error {
	watcher, err := lc.WatchIPNBus(ctx, ipn.NotifyInitialState|ipn.NotifyInitialPrefs|ipn.NotifyInitialNetMap)
	if err != nil {
		return err
	}
	defer watcher.Close()

	// debounce coalesces rapid IPN notifications into a single status refresh.
	const debounceDuration = 150 * time.Millisecond
	var debounceTimer *time.Timer
	var debounceMu sync.Mutex
	stopDebounce := func() {
		debounceMu.Lock()
		defer debounceMu.Unlock()
		if debounceTimer != nil {
			debounceTimer.Stop()
			debounceTimer = nil
		}
	}
	defer stopDebounce()

	// sendDebounced schedules a status refresh after debounceDuration,
	// resetting any pending timer so only the last event in a burst fires.
	sendDebounced := func() {
		debounceMu.Lock()
		defer debounceMu.Unlock()
		if debounceTimer != nil {
			debounceTimer.Stop()
		}
		debounceTimer = time.AfterFunc(debounceDuration, func() {
			debounceMu.Lock()
			debounceTimer = nil
			debounceMu.Unlock()
			status, err := h.refreshFullStatusFor(lc, generation)
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
			return ctx.Err()
		default:
		}

		n, err := watcher.Next()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		if !h.isCurrentSession(lc, generation) {
			return context.Canceled
		}

		stateChanged := n.State != nil
		prefsChanged := n.Prefs != nil && n.Prefs.Valid()
		browseURLChanged := n.BrowseToURL != nil
		healthChanged := n.Health != nil
		changed := stateChanged || prefsChanged || browseURLChanged || n.NetMap != nil || healthChanged
		var prefs *PrefsView
		if prefsChanged {
			prefs = prefsViewFromIPN(*n.Prefs)
		}
		var health []string
		if n.Health != nil {
			for _, w := range n.Health.Warnings {
				// tsnet doesn't manage system DNS; suppress irrelevant warnings
				if strings.Contains(w.Text, "getting OS base config is not supported") {
					continue
				}
				health = append(health, w.Text)
			}
		}

		if changed {
			// Hold the session read lock while updating the cache. A re-init must
			// therefore wait, then clears these values after replacing the session.
			h.sessionMu.RLock()
			if h.lc != lc || h.sessionGeneration != generation {
				h.sessionMu.RUnlock()
				return context.Canceled
			}
			h.stateMu.Lock()
			if stateChanged {
				h.lastState = n.State.String()
			}
			if prefsChanged {
				h.lastPrefs = prefs
			}
			if browseURLChanged {
				h.lastBrowseToURL = *n.BrowseToURL
			}
			if healthChanged {
				h.lastHealth = health
			}
			h.stateMu.Unlock()
			h.sessionMu.RUnlock()
			sendDebounced()
		}
	}
}

func prefsViewFromIPN(p ipn.PrefsView) *PrefsView {
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
	ar := p.AdvertiseRoutes()
	if n := ar.Len(); n > 0 {
		pv.AdvertiseRoutes = make([]string, 0, n)
		for i := 0; i < n; i++ {
			pv.AdvertiseRoutes = append(pv.AdvertiseRoutes, ar.At(i).String())
		}
	}
	if p.ExitNodeID() != "" {
		pv.ExitNodeID = string(p.ExitNodeID())
	}
	return pv
}

// refreshFullStatus calls the local client Status API and builds a full
// StatusUpdate from the enriched peer info plus cached IPN bus state.
func (h *Host) refreshFullStatus() (*StatusUpdate, error) {
	_, lc, generation := h.sessionSnapshot()
	if lc == nil {
		return nil, fmt.Errorf("local client not initialized")
	}
	return h.refreshFullStatusFor(lc, generation)
}

func (h *Host) refreshFullStatusFor(lc *local.Client, generation uint64) (*StatusUpdate, error) {

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	st, err := lc.Status(ctx)
	if err != nil {
		return nil, err
	}
	if !h.isCurrentSession(lc, generation) {
		return nil, fmt.Errorf("session changed while refreshing status")
	}

	update := h.buildStatusUpdate(st)
	if !h.isCurrentSession(lc, generation) {
		return nil, fmt.Errorf("session changed while building status")
	}
	return update, nil
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
	authURL := st.AuthURL
	if browseToURL == "" {
		browseToURL = authURL
	}

	update := &StatusUpdate{
		BackendState: state,
		Running:      state == "Running",
		NeedsLogin:   state == "NeedsLogin" || state == "NeedsMachineAuth",
		BrowseToURL:  browseToURL,
		AuthURL:      authURL,
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
