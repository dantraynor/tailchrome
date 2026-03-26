import { describe, it, expect } from "vitest";
import {
  ipToNum,
  parseCIDR,
  sanitizeMagicDNSSuffix,
  collectSubnetCIDRs,
  shouldProxyState,
  CGNAT_NETWORK,
  CGNAT_MASK,
} from "./proxy-utils";
import type { PeerInfo, TailscaleState } from "../types";

// === ipToNum ===

describe("ipToNum", () => {
  it("converts a standard IP to its numeric value", () => {
    expect(ipToNum("0.0.0.0")).toBe(0);
    expect(ipToNum("255.255.255.255")).toBe(0xffffffff);
    expect(ipToNum("100.64.0.0")).toBe(0x64400000);
    expect(ipToNum("10.0.0.1")).toBe(0x0a000001);
  });

  it("returns null for non-IP strings", () => {
    expect(ipToNum("not-an-ip")).toBeNull();
    expect(ipToNum("example.com")).toBeNull();
    expect(ipToNum("")).toBeNull();
  });

  it("returns null for wrong number of octets", () => {
    expect(ipToNum("10.0.0")).toBeNull();
    expect(ipToNum("10.0.0.0.0")).toBeNull();
  });

  it("returns null for out-of-range octets", () => {
    expect(ipToNum("256.0.0.0")).toBeNull();
    expect(ipToNum("10.0.0.-1")).toBeNull();
  });

  it("returns null for non-numeric octets", () => {
    expect(ipToNum("10.0.0.x")).toBeNull();
    expect(ipToNum("10.0.0.")).toBeNull();
  });
});

// === parseCIDR ===

describe("parseCIDR (numeric)", () => {
  it("parses a standard /24 CIDR", () => {
    const result = parseCIDR("10.0.0.0/24");
    expect(result).not.toBeNull();
    expect(result!.network).toBe(ipToNum("10.0.0.0"));
    expect(result!.mask).toBe(0xffffff00);
  });

  it("handles /0 (wildcard mask)", () => {
    const result = parseCIDR("0.0.0.0/0");
    expect(result).not.toBeNull();
    expect(result!.mask).toBe(0);
  });

  it("handles /32 (host mask)", () => {
    const result = parseCIDR("10.0.0.5/32");
    expect(result).not.toBeNull();
    expect(result!.mask).toBe(0xffffffff);
    expect(result!.network).toBe(ipToNum("10.0.0.5"));
  });

  it("handles /8", () => {
    const result = parseCIDR("172.0.0.0/8");
    expect(result).not.toBeNull();
    expect(result!.mask).toBe(0xff000000);
  });

  it("returns null for invalid CIDR notation", () => {
    expect(parseCIDR("not-a-cidr")).toBeNull();
    expect(parseCIDR("10.0.0.0")).toBeNull();
    expect(parseCIDR("10.0.0.0/abc")).toBeNull();
  });

  it("returns null for prefix length > 32", () => {
    expect(parseCIDR("10.0.0.0/33")).toBeNull();
  });

  it("returns null for negative prefix length", () => {
    expect(parseCIDR("10.0.0.0/-1")).toBeNull();
  });

  it("returns null for non-IP network part", () => {
    expect(parseCIDR("example.com/24")).toBeNull();
  });
});

describe("parseCIDR (string format)", () => {
  it("returns string network and mask for /24", () => {
    const result = parseCIDR("10.0.0.0/24", "string");
    expect(result).not.toBeNull();
    expect(result!.network).toBe("10.0.0.0");
    expect(result!.mask).toBe("255.255.255.0");
  });

  it("returns string mask for /0", () => {
    const result = parseCIDR("0.0.0.0/0", "string");
    expect(result!.mask).toBe("0.0.0.0");
  });

  it("returns string mask for /32", () => {
    const result = parseCIDR("10.0.0.5/32", "string");
    expect(result!.mask).toBe("255.255.255.255");
    expect(result!.network).toBe("10.0.0.5");
  });

  it("returns string mask for /8", () => {
    const result = parseCIDR("172.0.0.0/8", "string");
    expect(result!.mask).toBe("255.0.0.0");
  });

  it("returns null for invalid CIDR", () => {
    expect(parseCIDR("not-a-cidr", "string")).toBeNull();
    expect(parseCIDR("10.0.0.0/33", "string")).toBeNull();
  });
});

// === sanitizeMagicDNSSuffix ===

describe("sanitizeMagicDNSSuffix", () => {
  it("returns suffix unchanged when safe", () => {
    expect(sanitizeMagicDNSSuffix("example.ts.net")).toBe("example.ts.net");
  });

  it("strips trailing dot", () => {
    expect(sanitizeMagicDNSSuffix("example.ts.net.")).toBe("example.ts.net");
  });

  it("rejects suffixes with unsafe characters", () => {
    expect(sanitizeMagicDNSSuffix('evil"); alert("xss')).toBe("");
    expect(sanitizeMagicDNSSuffix("bad suffix!")).toBe("");
  });

  it("returns empty string for null", () => {
    expect(sanitizeMagicDNSSuffix(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(sanitizeMagicDNSSuffix(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(sanitizeMagicDNSSuffix("")).toBe("");
  });

  it("allows hyphens in domain names", () => {
    expect(sanitizeMagicDNSSuffix("my-company.ts.net")).toBe("my-company.ts.net");
  });
});

// === collectSubnetCIDRs ===

function makePeer(overrides: Partial<PeerInfo> = {}): PeerInfo {
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

describe("collectSubnetCIDRs", () => {
  it("returns empty array when no peers", () => {
    expect(collectSubnetCIDRs([])).toEqual([]);
  });

  it("returns empty array when no subnet routers", () => {
    const peer = makePeer({ isSubnetRouter: false, subnets: ["10.0.0.0/24"] });
    expect(collectSubnetCIDRs([peer])).toEqual([]);
  });

  it("returns empty array when subnet router has no subnets", () => {
    const peer = makePeer({ isSubnetRouter: true, subnets: [] });
    expect(collectSubnetCIDRs([peer])).toEqual([]);
  });

  it("collects subnets from a subnet router peer", () => {
    const peer = makePeer({ isSubnetRouter: true, subnets: ["10.0.0.0/24", "192.168.1.0/16"] });
    expect(collectSubnetCIDRs([peer])).toEqual(["10.0.0.0/24", "192.168.1.0/16"]);
  });

  it("collects subnets from multiple subnet router peers", () => {
    const peers = [
      makePeer({ id: "p1", isSubnetRouter: true, subnets: ["10.0.0.0/24"] }),
      makePeer({ id: "p2", isSubnetRouter: false, subnets: ["172.16.0.0/12"] }),
      makePeer({ id: "p3", isSubnetRouter: true, subnets: ["192.168.0.0/16"] }),
    ];
    expect(collectSubnetCIDRs(peers)).toEqual(["10.0.0.0/24", "192.168.0.0/16"]);
  });
});

// === shouldProxyState ===

function baseState(overrides: Partial<TailscaleState> = {}): TailscaleState {
  return {
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
    ...overrides,
  };
}

describe("shouldProxyState", () => {
  it("returns true when all conditions are met", () => {
    expect(shouldProxyState(baseState())).toBe(true);
  });

  it("returns false when proxyEnabled is false", () => {
    expect(shouldProxyState(baseState({ proxyEnabled: false }))).toBe(false);
  });

  it("returns false when proxyPort is null", () => {
    expect(shouldProxyState(baseState({ proxyPort: null }))).toBe(false);
  });

  it("returns false when backendState is not Running", () => {
    expect(shouldProxyState(baseState({ backendState: "Stopped" }))).toBe(false);
    expect(shouldProxyState(baseState({ backendState: "Starting" }))).toBe(false);
    expect(shouldProxyState(baseState({ backendState: "NeedsLogin" }))).toBe(false);
  });

  it("returns false when multiple conditions fail", () => {
    expect(shouldProxyState(baseState({ proxyEnabled: false, backendState: "Stopped" }))).toBe(false);
  });
});

// === CGNAT constants ===

describe("CGNAT constants", () => {
  it("CGNAT_NETWORK matches 100.64.0.0", () => {
    expect(CGNAT_NETWORK).toBe(ipToNum("100.64.0.0"));
  });

  it("CGNAT_MASK matches /10 mask (255.192.0.0)", () => {
    expect(CGNAT_MASK).toBe(0xffc00000);
  });

  it("100.64.0.0/10 network matches Tailscale CGNAT range", () => {
    const check = (ip: string) => {
      const num = ipToNum(ip)!;
      return (num & CGNAT_MASK) === (CGNAT_NETWORK & CGNAT_MASK);
    };
    expect(check("100.64.0.1")).toBe(true);
    expect(check("100.127.255.255")).toBe(true);
    expect(check("100.100.100.100")).toBe(true);
    // Outside range
    expect(check("100.128.0.0")).toBe(false);
    expect(check("10.0.0.1")).toBe(false);
  });
});
