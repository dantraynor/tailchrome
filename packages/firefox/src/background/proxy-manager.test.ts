import { describe, it, expect, beforeEach } from "vitest";
import {
  FirefoxProxyManager,
  resolveProxy,
  type PersistedProxyConfig,
} from "./proxy-manager";
import { baseState, makePeer } from "@tailchrome/shared/__test__/fixtures";


describe("FirefoxProxyManager", () => {
  let pm: FirefoxProxyManager;
  let currentConfig: PersistedProxyConfig | null;

  beforeEach(() => {
    currentConfig = null;
    pm = new FirefoxProxyManager((config) => {
      currentConfig = config;
    });
  });

  describe("apply / clear", () => {
    it("sets config when state is running and proxy enabled", () => {
      pm.apply(baseState());
      expect(currentConfig).not.toBeNull();
      expect(currentConfig!.proxyPort).toBe(1055);
    });

    it("clears config when backend is not running", () => {
      pm.apply(baseState());
      expect(currentConfig).not.toBeNull();
      pm.apply(baseState({ backendState: "Stopped" }));
      expect(currentConfig).toBeNull();
    });

    it("clears config when proxyEnabled is false", () => {
      pm.apply(baseState());
      pm.apply(baseState({ proxyEnabled: false }));
      expect(currentConfig).toBeNull();
    });

    it("does nothing when proxy was never enabled and state is stopped", () => {
      pm.apply(baseState({ backendState: "Stopped" }));
      expect(currentConfig).toBeNull();
    });

    it("clears stale restored config on first apply with non-proxy state (wake scenario)", () => {
      // Simulate event page wake: config was restored from session storage
      // before FirefoxProxyManager was instantiated
      currentConfig = {
        proxyPort: 1055,
        magicDNSSuffix: "example.ts.net",
        exitNodeActive: false,
        subnetRanges: [],
      };
      // Fresh proxy manager (as after wake) gets a "stopped" state first
      pm.apply(baseState({ backendState: "Stopped" }));
      // Must clear the stale config even though this PM instance never set it
      expect(currentConfig).toBeNull();
    });
  });

  describe("routing decisions (via resolveProxy)", () => {
    it("routes Tailscale IPs through proxy, regular sites DIRECT", () => {
      pm.apply(baseState());

      expect(resolveProxy("http://google.com", currentConfig!).type).toBe("direct");
      expect(resolveProxy("http://100.64.0.5", currentConfig!).type).toBe("socks");
      expect(resolveProxy("http://100.64.0.5", currentConfig!).port).toBe(1055);
      expect(resolveProxy("http://100.100.100.100", currentConfig!).type).toBe("socks");
      expect(resolveProxy("http://100.127.255.255", currentConfig!).type).toBe("socks");
    });

    it("routes MagicDNS names through proxy", () => {
      pm.apply(baseState());

      expect(resolveProxy("http://my-server.example.ts.net", currentConfig!).type).toBe("socks");
      expect(resolveProxy("http://example.ts.net", currentConfig!).type).toBe("socks");
      // But not partial matches
      expect(resolveProxy("http://notexample.ts.net", currentConfig!).type).toBe("direct");
    });

    it("routes everything through proxy when exit node is active", () => {
      pm.apply(baseState({
        exitNode: { id: "exit1", hostname: "exit", location: null, online: true },
      }));

      expect(resolveProxy("http://google.com", currentConfig!).type).toBe("socks");
      expect(resolveProxy("http://192.168.1.1", currentConfig!).type).toBe("socks");
      expect(resolveProxy("https://example.com/path", currentConfig!).type).toBe("socks");
    });

    it("routes everything through proxy via Mullvad exit node", () => {
      pm.apply(baseState({
        exitNode: {
          id: "mullvad-se1",
          hostname: "se-sto-wg-001",
          location: { city: "Stockholm", country: "Sweden", countryCode: "SE" },
          online: true,
        },
      }));

      expect(resolveProxy("http://google.com", currentConfig!).type).toBe("socks");
      expect(resolveProxy("http://192.168.1.1", currentConfig!).type).toBe("socks");
      expect(resolveProxy("http://8.8.8.8", currentConfig!).type).toBe("socks");
      expect(resolveProxy("http://100.64.0.5", currentConfig!).type).toBe("socks");
    });

    it("routes subnet ranges through proxy", () => {
      pm.apply(baseState({
        peers: [makePeer({ subnets: ["10.0.0.0/24", "172.16.0.0/12"] })],
      }));

      // Inside subnets
      expect(resolveProxy("http://10.0.0.50", currentConfig!).type).toBe("socks");
      expect(resolveProxy("http://172.20.5.1", currentConfig!).type).toBe("socks");
      // Outside subnets
      expect(resolveProxy("http://10.0.1.1", currentConfig!).type).toBe("direct");
      expect(resolveProxy("http://172.32.0.1", currentConfig!).type).toBe("direct");
    });

    it("does not proxy non-Tailscale IPs outside CGNAT range", () => {
      pm.apply(baseState());

      expect(resolveProxy("http://192.168.1.1", currentConfig!).type).toBe("direct");
      expect(resolveProxy("http://10.0.0.1", currentConfig!).type).toBe("direct");
      expect(resolveProxy("http://8.8.8.8", currentConfig!).type).toBe("direct");
    });

    it("uses the configured proxy port", () => {
      pm.apply(baseState({ proxyPort: 9999 }));

      const result = resolveProxy("http://100.64.0.1", currentConfig!);
      expect(result.type).toBe("socks");
      expect(result.port).toBe(9999);
    });

    it("returns proxyDNS: true for SOCKS proxy", () => {
      pm.apply(baseState());

      const result = resolveProxy("http://100.64.0.1", currentConfig!);
      expect(result.proxyDNS).toBe(true);
    });
  });

  describe("MagicDNS handling", () => {
    it("strips trailing dot from MagicDNS suffix", () => {
      pm.apply(baseState({ magicDNSSuffix: "example.ts.net." }));

      expect(resolveProxy("http://my-server.example.ts.net", currentConfig!).type).toBe("socks");
    });

    it("handles null MagicDNS suffix", () => {
      pm.apply(baseState({ magicDNSSuffix: null }));

      // Regular hostname should go direct
      expect(resolveProxy("http://my-server.example.ts.net", currentConfig!).type).toBe("direct");
    });

    it("sanitizes unsafe MagicDNS suffix characters", () => {
      pm.apply(baseState({ magicDNSSuffix: 'evil"); alert("xss' }));

      // Should not match since the suffix was rejected
      expect(resolveProxy("http://evil", currentConfig!).type).toBe("direct");
    });
  });
});
