package main

import (
	"time"

	"tailscale.com/ipn/ipnstate"
)

// extractPeers builds a slice of PeerInfo from the ipnstate.Status peer map.
func extractPeers(st *ipnstate.Status) []PeerInfo {
	if st == nil {
		return nil
	}

	peers := make([]PeerInfo, 0, len(st.Peer))
	for _, ps := range st.Peer {
		peers = append(peers, peerStatusToPeerInfo(ps, st))
	}
	return peers
}

// peerStatusToPeerInfo converts an ipnstate.PeerStatus into our PeerInfo type,
// resolving user information from the Status.User map.
func peerStatusToPeerInfo(ps *ipnstate.PeerStatus, st *ipnstate.Status) PeerInfo {
	pi := PeerInfo{
		ID:             string(ps.ID),
		Hostname:       ps.HostName,
		DNSName:        ps.DNSName,
		OS:             ps.OS,
		Online:         ps.Online,
		Active:         ps.Active,
		ExitNode:       ps.ExitNode,
		ExitNodeOption: ps.ExitNodeOption,
		RxBytes:        ps.RxBytes,
		TxBytes:        ps.TxBytes,
	}

	// Extract Tailscale IPs.
	for _, ip := range ps.TailscaleIPs {
		pi.TailscaleIPs = append(pi.TailscaleIPs, ip.String())
	}
	if pi.TailscaleIPs == nil {
		pi.TailscaleIPs = []string{}
	}

	// Extract tags.
	if ps.Tags != nil {
		n := ps.Tags.Len()
		for i := range n {
			pi.Tags = append(pi.Tags, ps.Tags.At(i))
		}
	}

	// Extract primary routes (subnet routes).
	if ps.PrimaryRoutes != nil {
		n := ps.PrimaryRoutes.Len()
		for i := range n {
			prefix := ps.PrimaryRoutes.At(i)
			pi.Subnets = append(pi.Subnets, prefix.String())
		}
		pi.IsSubnetRouter = n > 0
	}

	// Timestamps.
	if !ps.LastSeen.IsZero() {
		pi.LastSeen = ps.LastSeen.UTC().Format("2006-01-02T15:04:05Z")
	}
	if !ps.LastHandshake.IsZero() {
		pi.LastHandshake = ps.LastHandshake.UTC().Format("2006-01-02T15:04:05Z")
	}
	if ps.KeyExpiry != nil {
		pi.KeyExpiry = ps.KeyExpiry.UTC().Format(time.RFC3339)
	}

	// Location info.
	if ps.Location != nil {
		pi.Location = &LocationInfo{
			City:        ps.Location.City,
			CityCode:    ps.Location.CityCode,
			Country:     ps.Location.Country,
			CountryCode: ps.Location.CountryCode,
			Latitude:    ps.Location.Latitude,
			Longitude:   ps.Location.Longitude,
		}
	}

	// Taildrop target status.
	pi.TaildropTarget = ps.TaildropTarget == ipnstate.TaildropTargetAvailable

	// SSH host capability: the peer has SSH host keys.
	pi.SSHHost = len(ps.SSH_HostKeys) > 0

	// Resolve user information from the UserProfile map.
	if st.User != nil && ps.UserID != 0 {
		if up, ok := st.User[ps.UserID]; ok {
			pi.UserID = int64(up.ID)
			pi.UserName = up.DisplayName
			pi.UserLoginName = up.LoginName
			pi.UserProfilePicURL = up.ProfilePicURL
		}
	}

	return pi
}
