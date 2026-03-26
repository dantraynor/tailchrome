import { describe, it, expect, beforeEach } from "vitest";
import { FirefoxProxyManager } from "./proxy-manager";
import { baseState, makePeer } from "@tailchrome/shared/__test__/fixtures";


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
      pm.apply(baseState());
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      expect(resolve("http://google.com").type).toBe("direct");
      expect(resolve("http://100.64.0.5").type).toBe("socks");
      expect(resolve("http://100.64.0.5").port).toBe(1055);
      expect(resolve("http://100.100.100.100").type).toBe("socks");
      expect(resolve("http://100.127.255.255").type).toBe("socks");
    });

    it("routes MagicDNS names through proxy", () => {
      pm.apply(baseState());
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      expect(resolve("http://my-server.example.ts.net").type).toBe("socks");
      expect(resolve("http://example.ts.net").type).toBe("socks");
      // But not partial matches
      expect(resolve("http://notexample.ts.net").type).toBe("direct");
    });

    it("routes everything through proxy when exit node is active", () => {
      pm.apply(baseState({
        exitNode: { id: "exit1", hostname: "exit", location: null, online: true },
      }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      expect(resolve("http://google.com").type).toBe("socks");
      expect(resolve("http://192.168.1.1").type).toBe("socks");
      expect(resolve("https://example.com/path").type).toBe("socks");
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
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      expect(resolve("http://google.com").type).toBe("socks");
      expect(resolve("http://192.168.1.1").type).toBe("socks");
      expect(resolve("http://8.8.8.8").type).toBe("socks");
      expect(resolve("http://100.64.0.5").type).toBe("socks");
    });

    it("routes subnet ranges through proxy", () => {
      pm.apply(baseState({
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
      pm.apply(baseState());
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      expect(resolve("http://192.168.1.1").type).toBe("direct");
      expect(resolve("http://10.0.0.1").type).toBe("direct");
      expect(resolve("http://8.8.8.8").type).toBe("direct");
    });

    it("uses the configured proxy port", () => {
      pm.apply(baseState({ proxyPort: 9999 }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      const result = resolve("http://100.64.0.1");
      expect(result.type).toBe("socks");
      expect(result.port).toBe(9999);
    });

    it("returns proxyDNS: true for SOCKS proxy", () => {
      pm.apply(baseState());
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      const result = resolve("http://100.64.0.1");
      expect(result.proxyDNS).toBe(true);
    });
  });

  describe("MagicDNS handling", () => {
    it("strips trailing dot from MagicDNS suffix", () => {
      pm.apply(baseState({ magicDNSSuffix: "example.ts.net." }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      expect(resolve("http://my-server.example.ts.net").type).toBe("socks");
    });

    it("handles null MagicDNS suffix", () => {
      pm.apply(baseState({ magicDNSSuffix: null }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      // Regular hostname should go direct
      expect(resolve("http://my-server.example.ts.net").type).toBe("direct");
    });

    it("sanitizes unsafe MagicDNS suffix characters", () => {
      pm.apply(baseState({ magicDNSSuffix: 'evil"); alert("xss' }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      // Should not match since the suffix was rejected
      expect(resolve("http://evil").type).toBe("direct");
    });
  });

});

