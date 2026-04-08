package main

import "encoding/json"

// maxMessageSize is the maximum message size for the native messaging protocol.
// Chrome enforces a 1MB limit on messages from the host to the extension.
const maxMessageSize = 1024 * 1024

// Request represents a message from the browser extension to the host.
type Request struct {
	Cmd    string          `json:"cmd"`
	InitID string          `json:"initID,omitempty"` // browser profile UUID, used with "init"
	NodeID string          `json:"nodeID,omitempty"` // used with "set-exit-node", "send-file", "ping-peer"
	Prefs  json.RawMessage `json:"prefs,omitempty"`  // partial prefs JSON, used with "set-prefs"
	Note   string          `json:"note,omitempty"`   // optional note for "bug-report"

	// For send-file
	FileName     string `json:"fileName,omitempty"`
	FileData     string `json:"fileData,omitempty"` // base64-encoded file content
	FileSize     int64  `json:"fileSize,omitempty"`
	TransferID   string `json:"transferID,omitempty"`
	ChunkIndex   int    `json:"chunkIndex,omitempty"`
	ChunkCount   int    `json:"chunkCount,omitempty"`

	// For profile management
	ProfileID string `json:"profileID,omitempty"`
}

// Reply represents a message from the host to the browser extension.
type Reply struct {
	Cmd                string                 `json:"cmd"`
	ProcRunning        *ProcRunningReply      `json:"procRunning,omitempty"`
	Init               *InitReply             `json:"init,omitempty"`
	Pong               *PongReply             `json:"pong,omitempty"`
	Status             *StatusUpdate          `json:"status,omitempty"`
	Profiles           *ProfilesReply         `json:"profiles,omitempty"`
	ExitNodeSuggestion *ExitNodeSuggestion    `json:"exitNodeSuggestion,omitempty"`
	FileSendProgress   *FileSendProgressReply `json:"fileSendProgress,omitempty"`
	Diagnostic         *DiagnosticReply       `json:"diagnostic,omitempty"`
	Error              *ErrorReply            `json:"error,omitempty"`
}

// ProcRunningReply is sent immediately after the host starts to inform the
// extension of the proxy port and process ID.
type ProcRunningReply struct {
	Port    int    `json:"port"`
	PID     int    `json:"pid"`
	Version string `json:"version"`
	Error   string `json:"error,omitempty"`
}

// InitReply is the response to an "init" command.
type InitReply struct {
	Error string `json:"error,omitempty"`
}

// PongReply is the response to a "ping" command.
type PongReply struct{}

// StatusUpdate contains the full state of the Tailscale node.
type StatusUpdate struct {
	BackendState   string     `json:"backendState"`
	Running        bool       `json:"running"`
	Tailnet        string     `json:"tailnet"`
	MagicDNSSuffix string     `json:"magicDNSSuffix"`
	SelfNode       *PeerInfo  `json:"selfNode,omitempty"`
	NeedsLogin     bool       `json:"needsLogin"`
	BrowseToURL    string     `json:"browseToURL,omitempty"`
	ExitNode       *PeerInfo  `json:"exitNode,omitempty"`
	Peers          []PeerInfo `json:"peers"`
	Prefs          *PrefsView `json:"prefs,omitempty"`
	Health         []string   `json:"health"`
	Error          string     `json:"error,omitempty"`
}

// PrefsView is a simplified view of the Tailscale preferences for the extension.
type PrefsView struct {
	ControlURL             string `json:"controlURL,omitempty"`
	RouteAll               bool   `json:"routeAll"`
	ExitNodeID             string `json:"exitNodeID,omitempty"`
	ExitNodeAllowLANAccess bool   `json:"exitNodeAllowLANAccess"`
	CorpDNS                bool   `json:"corpDNS"`
	WantRunning            bool   `json:"wantRunning"`
	ShieldsUp              bool   `json:"shieldsUp"`
	Hostname               string `json:"hostname,omitempty"`
	RunSSH                 bool   `json:"runSSH"`
	RunWebClient           bool     `json:"runWebClient"`
	AdvertiseExitNode      bool     `json:"advertiseExitNode"`
	AdvertiseRoutes        []string `json:"advertiseRoutes,omitempty"`
}

// PeerInfo contains information about a Tailscale peer node.
type PeerInfo struct {
	ID                 string         `json:"id"`
	Hostname           string         `json:"hostname"`
	DNSName            string         `json:"dnsName"`
	TailscaleIPs       []string       `json:"tailscaleIPs"`
	OS                 string         `json:"os"`
	Online             bool           `json:"online"`
	Active             bool           `json:"active"`
	ExitNode           bool           `json:"exitNode"`
	ExitNodeOption     bool           `json:"exitNodeOption"`
	IsSubnetRouter     bool           `json:"isSubnetRouter"`
	Subnets            []string       `json:"subnets,omitempty"`
	Tags               []string       `json:"tags,omitempty"`
	RxBytes            int64          `json:"rxBytes"`
	TxBytes            int64          `json:"txBytes"`
	LastSeen           string         `json:"lastSeen,omitempty"`
	LastHandshake      string         `json:"lastHandshake,omitempty"`
	KeyExpiry          string         `json:"keyExpiry,omitempty"`
	Location           *LocationInfo  `json:"location,omitempty"`
	TaildropTarget     bool           `json:"taildropTarget"`
	SSHHost            bool           `json:"sshHost"`
	UserID             int64          `json:"userId"`
	UserName           string         `json:"userName"`
	UserLoginName      string         `json:"userLoginName"`
	UserProfilePicURL  string         `json:"userProfilePicURL"`
}

// LocationInfo contains geographic location information for a node.
type LocationInfo struct {
	City        string  `json:"city,omitempty"`
	CityCode    string  `json:"cityCode,omitempty"`
	Country     string  `json:"country,omitempty"`
	CountryCode string  `json:"countryCode,omitempty"`
	Latitude    float64 `json:"latitude,omitempty"`
	Longitude   float64 `json:"longitude,omitempty"`
}

// ProfilesReply is the response to profile management commands.
type ProfilesReply struct {
	Current  ProfileInfo   `json:"current"`
	Profiles []ProfileInfo `json:"profiles"`
}

// ProfileInfo contains information about a Tailscale profile.
type ProfileInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ExitNodeSuggestion is the response to a "suggest-exit-node" command.
type ExitNodeSuggestion struct {
	ID       string        `json:"id"`
	Hostname string        `json:"hostname"`
	Location *LocationInfo `json:"location,omitempty"`
}

// FileSendProgressReply reports progress of a file send operation.
type FileSendProgressReply struct {
	TargetNodeID string  `json:"targetNodeID"`
	Name         string  `json:"name"`
	Percent      float64 `json:"percent"`
	Done         bool    `json:"done"`
	Error        string  `json:"error,omitempty"`
}

// ErrorReply is sent when a command fails.
type ErrorReply struct {
	Cmd     string `json:"cmd"`
	Message string `json:"message"`
}

// DiagnosticReply carries human-readable diagnostic output for commands
// such as ping-peer, bug-report, or netcheck.
type DiagnosticReply struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}
