import { describe, it, expect, beforeEach } from "vitest";
import { FirefoxProxyManager } from "./proxy-manager";
import type { TailscaleState } from "@tailchrome/shared/shared/types";

function baseState(overrides: Partial<TailscaleState> = {}): TailscaleState {
  return {
    hostConnected: true,
    initialized: true,
    proxyPort: 1055,
    proxyEnabled: true,
    backendState: "Running",
    tailnet: "example.ts.net",
    selfNode: {
      id: "self1",
      hostname: "my-laptop",
      dnsName: "my-laptop.example.ts.net.",
      tailscaleIPs: ["100.64.0.1"],
      os: "linux",
      online: true,
      keyExpiry: null,
    },
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

/**
 * Helper: apply state to the proxy manager and return a function
 * that resolves proxy for a given URL.
 */
function setupProxy(
  pm: FirefoxProxyManager,
  state: TailscaleState,
): (url: string) => { type: string; host?: string; port?: number } {
  pm.apply(state);
  // Access the internal listener via the browser mock
  const listeners = (globalThis as any).browser.proxy.onRequest;
  // The proxy manager registers one listener — call it directly
  return (url: string) => {
    // We call resolveProxy indirectly through apply -> listener
    // Use a fresh apply to update state, then simulate a request
    const result = (pm as any).resolveProxy(url);
    return result;
  };
}

describe("FirefoxProxyManager", () => {
  let pm: FirefoxProxyManager;

  beforeEach(() => {
    pm = new FirefoxProxyManager();
  });

  describe("apply / clear", () => {
    it("registers listener when state is running and proxy enabled", () => {
      pm.apply(baseState());
      const hasListener = (globalThis as any).browser.proxy.onRequest.hasListener;
      // At least the listener was added (we can check the proxy manager is active)
      expect((pm as any).currentlyEnabled).toBe(true);
    });

    it("removes listener when backend is not running", () => {
      pm.apply(baseState());
      expect((pm as any).currentlyEnabled).toBe(true);
      pm.apply(baseState({ backendState: "Stopped" }));
      expect((pm as any).currentlyEnabled).toBe(false);
    });

    it("removes listener when proxyEnabled is false", () => {
      pm.apply(baseState());
      pm.apply(baseState({ proxyEnabled: false }));
      expect((pm as any).currentlyEnabled).toBe(false);
    });

    it("does nothing when proxy was never enabled and state is stopped", () => {
      pm.apply(baseState({ backendState: "Stopped" }));
      expect((pm as any).currentlyEnabled).toBe(false);
    });
  });

  describe("routing decisions", () => {
    it("routes Tailscale IPs through proxy, regular sites DIRECT", () => {
      setupProxy(pm, baseState());
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      expect(resolve("http://google.com").type).toBe("direct");
      expect(resolve("http://100.64.0.5").type).toBe("socks");
      expect(resolve("http://100.64.0.5").port).toBe(1055);
      expect(resolve("http://100.100.100.100").type).toBe("socks");
      expect(resolve("http://100.127.255.255").type).toBe("socks");
    });

    it("routes MagicDNS names through proxy", () => {
      setupProxy(pm, baseState());
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      expect(resolve("http://my-server.example.ts.net").type).toBe("socks");
      expect(resolve("http://example.ts.net").type).toBe("socks");
      // But not partial matches
      expect(resolve("http://notexample.ts.net").type).toBe("direct");
    });

    it("routes everything through proxy when exit node is active", () => {
      setupProxy(pm, baseState({
        exitNode: { id: "exit1", hostname: "exit", location: null, online: true },
      }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      expect(resolve("http://google.com").type).toBe("socks");
      expect(resolve("http://192.168.1.1").type).toBe("socks");
      expect(resolve("https://example.com/path").type).toBe("socks");
    });

    it("routes everything through proxy via Mullvad exit node", () => {
      setupProxy(pm, baseState({
        exitNode: {
          id: "mullvad-se1",
          hostname: "se-sto-wg-001",
          location: { city: "Stockholm", country: "Sweden", countryCode: "SE" },
          online: true,
        },
      }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      expect(resolve("http://google.com").type).toBe("socks");
      expect(resolve("http://192.168.1.1").type).toBe("socks");
      expect(resolve("http://8.8.8.8").type).toBe("socks");
      expect(resolve("http://100.64.0.5").type).toBe("socks");
    });

    it("routes subnet ranges through proxy", () => {
      setupProxy(pm, baseState({
        peers: [makePeer({ subnets: ["10.0.0.0/24", "172.16.0.0/12"] })],
      }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      // Inside subnets
      expect(resolve("http://10.0.0.50").type).toBe("socks");
      expect(resolve("http://172.20.5.1").type).toBe("socks");
      // Outside subnets
      expect(resolve("http://10.0.1.1").type).toBe("direct");
      expect(resolve("http://172.32.0.1").type).toBe("direct");
    });

    it("does not proxy non-Tailscale IPs outside CGNAT range", () => {
      setupProxy(pm, baseState());
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      expect(resolve("http://192.168.1.1").type).toBe("direct");
      expect(resolve("http://10.0.0.1").type).toBe("direct");
      expect(resolve("http://8.8.8.8").type).toBe("direct");
    });

    it("uses the configured proxy port", () => {
      setupProxy(pm, baseState({ proxyPort: 9999 }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      const result = resolve("http://100.64.0.1");
      expect(result.type).toBe("socks");
      expect(result.port).toBe(9999);
    });

    it("returns proxyDNS: true for SOCKS proxy", () => {
      setupProxy(pm, baseState());
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      const result = resolve("http://100.64.0.1");
      expect(result.proxyDNS).toBe(true);
    });
  });

  describe("MagicDNS handling", () => {
    it("strips trailing dot from MagicDNS suffix", () => {
      setupProxy(pm, baseState({ magicDNSSuffix: "example.ts.net." }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      expect(resolve("http://my-server.example.ts.net").type).toBe("socks");
    });

    it("handles null MagicDNS suffix", () => {
      setupProxy(pm, baseState({ magicDNSSuffix: null }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      // Regular hostname should go direct
      expect(resolve("http://my-server.example.ts.net").type).toBe("direct");
    });

    it("sanitizes unsafe MagicDNS suffix characters", () => {
      setupProxy(pm, baseState({ magicDNSSuffix: 'evil"); alert("xss' }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      // Should not match since the suffix was rejected
      expect(resolve("http://evil").type).toBe("direct");
    });
  });

  describe("CIDR edge cases", () => {
    it("handles /0 (all traffic)", () => {
      setupProxy(pm, baseState({
        peers: [makePeer({ subnets: ["0.0.0.0/0"] })],
      }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      expect(resolve("http://1.2.3.4").type).toBe("socks");
    });

    it("handles /32 (single host)", () => {
      setupProxy(pm, baseState({
        peers: [makePeer({ subnets: ["10.0.0.5/32"] })],
      }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      expect(resolve("http://10.0.0.5").type).toBe("socks");
      expect(resolve("http://10.0.0.6").type).toBe("direct");
    });

    it("skips invalid CIDR notation", () => {
      setupProxy(pm, baseState({
        peers: [makePeer({ subnets: ["not-a-cidr", "10.0.0.0/24"] })],
      }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      expect(resolve("http://10.0.0.50").type).toBe("socks");
    });

    it("skips CIDR with prefix > 32", () => {
      setupProxy(pm, baseState({
        peers: [makePeer({ subnets: ["10.0.0.0/33"] })],
      }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      expect(resolve("http://10.0.0.1").type).toBe("direct");
    });

    it("handles non-IP hostnames gracefully", () => {
      setupProxy(pm, baseState({
        peers: [makePeer({ subnets: ["10.0.0.0/24"] })],
      }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      // Non-IP hostname shouldn't match subnet routes
      expect(resolve("http://my-server.local").type).toBe("direct");
    });
  });
});

/** Helper to create a minimal subnet-router peer */
function makePeer(
  overrides: Partial<{
    subnets: string[];
    isSubnetRouter: boolean;
  }> = {},
) {
  return {
    id: "peer-sr",
    hostname: "subnet-router",
    dnsName: "subnet-router.example.ts.net.",
    tailscaleIPs: ["100.64.0.10"],
    os: "linux",
    online: true,
    active: true,
    exitNode: false,
    exitNodeOption: false,
    isSubnetRouter: overrides.isSubnetRouter ?? true,
    subnets: overrides.subnets ?? [],
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
  };
}
