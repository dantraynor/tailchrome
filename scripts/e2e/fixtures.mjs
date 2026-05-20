export function makePeer(overrides = {}) {
  return {
    id: "peer-router",
    hostname: "router",
    dnsName: "router.example.ts.net.",
    tailscaleIPs: ["100.64.0.2"],
    os: "linux",
    online: true,
    active: true,
    exitNode: false,
    exitNodeOption: false,
    isSubnetRouter: false,
    subnets: [],
    tags: [],
    rxBytes: 2048,
    txBytes: 4096,
    lastSeen: null,
    lastHandshake: new Date(Date.now() - 60_000).toISOString(),
    keyExpiry: null,
    location: null,
    taildropTarget: false,
    sshHost: false,
    userId: 1,
    userName: "Example User",
    userLoginName: "user@example.com",
    userProfilePicURL: "",
    ...overrides,
  };
}

export function makeExitNodePeer(overrides = {}) {
  return makePeer({
    id: "peer-exit",
    hostname: "exitbox",
    dnsName: "exitbox.example.ts.net.",
    tailscaleIPs: ["100.64.0.9"],
    exitNode: false,
    exitNodeOption: true,
    location: {
      city: "New York",
      cityCode: "nyc",
      country: "United States",
      countryCode: "US",
    },
    ...overrides,
  });
}

export function makeMullvadPeer(overrides = {}) {
  return makeExitNodePeer({
    id: "mullvad-us-nyc",
    hostname: "us-nyc-wg-101.mullvad.ts.net",
    dnsName: "us-nyc-wg-101.mullvad.ts.net.",
    tags: ["tag:mullvad-exit-node"],
    location: {
      city: "New York",
      cityCode: "nyc",
      country: "United States",
      countryCode: "US",
    },
    ...overrides,
  });
}

export function makeRunningState(overrides = {}) {
  return {
    backendState: "Running",
    running: true,
    tailnet: "example.ts.net",
    magicDNSSuffix: "example.ts.net",
    selfNode: {
      id: "self",
      hostname: "browser-node",
      dnsName: "browser-node.example.ts.net.",
      tailscaleIPs: ["100.64.0.1"],
      os: "macOS",
      online: true,
      keyExpiry: "2027-01-15T12:00:00Z",
    },
    needsLogin: false,
    browseToURL: "",
    exitNode: null,
    peers: [
      makePeer({
        id: "peer-router",
        hostname: "router",
        isSubnetRouter: true,
        subnets: ["192.168.50.0/24"],
      }),
      makePeer({
        id: "peer-laptop",
        hostname: "laptop",
        dnsName: "laptop.example.ts.net.",
        tailscaleIPs: ["100.64.0.3"],
        os: "macOS",
        sshHost: true,
        taildropTarget: true,
      }),
      makePeer({
        id: "peer-offline",
        hostname: "archive",
        dnsName: "archive.example.ts.net.",
        tailscaleIPs: ["100.64.0.4"],
        online: false,
        active: false,
        lastSeen: new Date(Date.now() - 3_600_000).toISOString(),
      }),
      makePeer({
        id: "peer-nas",
        hostname: "nas",
        dnsName: "nas.example.ts.net.",
        tailscaleIPs: ["100.64.0.5"],
        os: "linux",
        tags: ["tag:storage"],
      }),
      makeExitNodePeer(),
      makeExitNodePeer({
        id: "peer-exit-sf",
        hostname: "exit-sf",
        dnsName: "exit-sf.example.ts.net.",
        tailscaleIPs: ["100.64.0.10"],
        location: {
          city: "San Francisco",
          cityCode: "sfo",
          country: "United States",
          countryCode: "US",
        },
      }),
      makeExitNodePeer({
        id: "peer-exit-london",
        hostname: "exit-london",
        dnsName: "exit-london.example.ts.net.",
        tailscaleIPs: ["100.64.0.11"],
        location: {
          city: "London",
          cityCode: "lon",
          country: "United Kingdom",
          countryCode: "GB",
        },
      }),
      makeExitNodePeer({
        id: "peer-exit-tokyo",
        hostname: "exit-tokyo",
        dnsName: "exit-tokyo.example.ts.net.",
        tailscaleIPs: ["100.64.0.12"],
        location: {
          city: "Tokyo",
          cityCode: "tyo",
          country: "Japan",
          countryCode: "JP",
        },
      }),
      makeMullvadPeer(),
    ],
    prefs: {
      exitNodeID: "",
      exitNodeAllowLANAccess: false,
      corpDNS: true,
      shieldsUp: false,
      advertiseExitNode: false,
      runSSH: false,
      advertiseRoutes: [],
    },
    health: [],
    error: null,
    ...overrides,
  };
}

export function makeStoppedState(overrides = {}) {
  return makeRunningState({
    backendState: "Stopped",
    running: false,
    peers: [],
    ...overrides,
  });
}

export function makeNeedsLoginState(overrides = {}) {
  return makeRunningState({
    backendState: "NeedsLogin",
    running: false,
    needsLogin: true,
    browseToURL: "https://login.tailscale.com/a/test",
    peers: [],
    ...overrides,
  });
}

export function makeProfiles(overrides = {}) {
  return {
    current: { id: "profile-work", name: "Work" },
    profiles: [
      { id: "profile-work", name: "Work" },
      { id: "profile-personal", name: "Personal" },
    ],
    ...overrides,
  };
}

export function makeControl(overrides = {}) {
  const status = overrides.status ?? makeRunningState();
  return {
    proxyPort: 1055,
    hostVersion: "0.1.9",
    supportsNetcheck: true,
    supportsPingPeer: true,
    supportsLogin: true,
    status,
    profiles: makeProfiles(),
    exitNodeSuggestion: {
      id: "peer-exit",
      hostname: "exitbox",
      location: {
        city: "New York",
        cityCode: "nyc",
        country: "United States",
        countryCode: "US",
      },
    },
    ...overrides,
  };
}
