import type { PeerInfo, TailscaleState } from "../types";

export function baseState(overrides: Partial<TailscaleState> = {}): TailscaleState {
  return {
    stateVersion: 0,
    hostConnected: true,
    initialized: true,
    proxyPort: 1055,
    proxyEnabled: true,
    backendState: "Running",
    tailnet: "example.ts.net",
    selfNode: null,
    peers: [],
    exitNode: null,
    magicDNSSuffix: "example.ts.net",
    browseToURL: null,
    prefs: null,
    health: [],
    currentProfile: null,
    profiles: [],
    exitNodeSuggestion: null,
    error: null,
    installError: false,
    hostVersion: null,
    hostVersionMismatch: false,
    ...overrides,
  };
}

export function makePeer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    id: "peer1",
    hostname: "router",
    dnsName: "router.example.ts.net.",
    tailscaleIPs: ["100.64.0.2"],
    os: "linux",
    online: true,
    active: true,
    exitNode: false,
    exitNodeOption: false,
    isSubnetRouter: true,
    subnets: [],
    tags: [],
    rxBytes: 0,
    txBytes: 0,
    lastSeen: null,
    lastHandshake: null,
    location: null,
    taildropTarget: false,
    sshHost: false,
    userId: 1,
    userName: "user",
    userLoginName: "user@example.com",
    userProfilePicURL: "",
    ...overrides,
  };
}
