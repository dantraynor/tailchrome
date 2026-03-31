import { describe, it, expect, beforeEach } from "vitest";
import { FirefoxProxyManager } from "./proxy-manager";
import { baseState, makePeer } from "@tailchrome/shared/__test__/fixtures";
import { resetSessionStorage } from "../__test__/browser-mock";


describe("FirefoxProxyManager", () => {
  let pm: FirefoxProxyManager;

  beforeEach(() => {
    resetSessionStorage();
    pm = new FirefoxProxyManager();
  });

  describe("apply / clear", () => {
    it("sets config when state is running and proxy enabled", () => {
      pm.apply(baseState());
      const browserProxy = (globalThis as any).browser.proxy.onRequest;
      expect(browserProxy.hasListener(pm.listener)).toBe(true);
    });

    it("clear() resets routing state so everything routes direct", () => {
      pm.apply(baseState());
      pm.clear();
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      // CGNAT IP should go direct after clear
      expect(resolve("http://100.64.0.5").type).toBe("direct");
      expect(resolve("http://100.100.100.100").type).toBe("direct");
    });

    it("clear() does NOT remove the proxy listener", () => {
      const browserProxy = (globalThis as any).browser.proxy.onRequest;
      pm.apply(baseState());
      expect(browserProxy.hasListener(pm.listener)).toBe(true);

      pm.clear();
      // Listener stays — it's owned by the entry point, not the manager
      expect(browserProxy.hasListener(pm.listener)).toBe(true);
    });

    it("apply with stopped state routes everything direct", () => {
      pm.apply(baseState());
      pm.apply(baseState({ backendState: "Stopped" }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      expect(resolve("http://100.64.0.5").type).toBe("direct");
    });

    it("apply with proxyEnabled false routes everything direct", () => {
      pm.apply(baseState());
      pm.apply(baseState({ proxyEnabled: false }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);

      expect(resolve("http://100.64.0.5").type).toBe("direct");
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

    it("returns direct synchronously when no config and no pending restore", () => {
      // Fresh instance with no apply() or restoreFromStorage() — no stored
      // config exists, so the listener returns direct synchronously.
      const result = pm.listener({ url: "http://100.64.0.5" });
      // Should be a synchronous FirefoxProxyInfo, not a Promise
      expect(result).not.toBeInstanceOf(Promise);
      expect((result as any).type).toBe("direct");
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

  describe("session storage persistence", () => {
    it("persists proxy config to session storage on apply", async () => {
      pm.apply(baseState({ proxyPort: 5555 }));

      // Restore into a fresh instance
      const pm2 = new FirefoxProxyManager();
      const restored = await pm2.restoreFromStorage();
      expect(restored).toBe(true);
      expect((pm2 as any).proxyPort).toBe(5555);
      expect((pm2 as any).magicDNSSuffix).toBe("example.ts.net");
    });

    it("restores exitNodeActive and subnetRanges", async () => {
      pm.apply(baseState({
        proxyPort: 1234,
        exitNode: { id: "exit1", hostname: "exit", location: null, online: true },
        peers: [makePeer({ subnets: ["10.0.0.0/24"] })],
      }));

      const pm2 = new FirefoxProxyManager();
      await pm2.restoreFromStorage();
      expect((pm2 as any).exitNodeActive).toBe(true);
      expect((pm2 as any).subnetRanges.length).toBeGreaterThan(0);
    });

    it("returns false from restoreFromStorage when nothing is stored", async () => {
      const restored = await pm.restoreFromStorage();
      expect(restored).toBe(false);
    });

    it("clear() does not wipe stored config (needed for restore on wake)", async () => {
      pm.apply(baseState());
      pm.clear();

      // Storage should survive — clear() is called during the disconnect
      // path when the event page suspends.
      const pm2 = new FirefoxProxyManager();
      const restored = await pm2.restoreFromStorage();
      expect(restored).toBe(true);
    });

    it("apply() with connected+stopped state wipes stored config", async () => {
      pm.apply(baseState());

      // Simulate the host reporting that Tailscale is stopped (authoritative)
      pm.apply(baseState({ hostConnected: true, backendState: "Stopped" }));

      const pm2 = new FirefoxProxyManager();
      const restored = await pm2.restoreFromStorage();
      expect(restored).toBe(false);
    });

    it("apply() on disconnect path preserves stored config", async () => {
      pm.apply(baseState());

      // Simulate the disconnect path (event page suspension):
      // hostConnected=false, proxyEnabled=false, proxyPort=null
      pm.apply(baseState({
        hostConnected: false,
        proxyEnabled: false,
        proxyPort: null,
        backendState: "NoState",
      }));

      // Storage must survive for restoreFromStorage() on next wake.
      //
      // Trade-off: if the disconnect was a real host crash (not suspension),
      // the restored port may be stale. This is intentional — requests to a
      // dead SOCKS port produce a visible connection error, which is safer
      // than silently routing Tailscale traffic direct. The native host
      // reconnects on wake and apply() updates the port promptly.
      const pm2 = new FirefoxProxyManager();
      const restored = await pm2.restoreFromStorage();
      expect(restored).toBe(true);
    });

    it("routes correctly after restoring from storage", async () => {
      pm.apply(baseState({ proxyPort: 7777 }));

      const pm2 = new FirefoxProxyManager();
      await pm2.restoreFromStorage();
      const resolve = (url: string) => (pm2 as any).resolveProxy(url);

      expect(resolve("http://100.64.0.5").type).toBe("socks");
      expect(resolve("http://100.64.0.5").port).toBe(7777);
      expect(resolve("http://my-server.example.ts.net").type).toBe("socks");
      expect(resolve("http://google.com").type).toBe("direct");
    });
  });

  describe("suspend / wake lifecycle", () => {
    it("full suspend/wake cycle: listener stays, state restores", async () => {
      const browserProxy = (globalThis as any).browser.proxy.onRequest;

      // 1. Entry point registers listener externally
      browserProxy.addListener(pm.listener, { urls: ["<all_urls>"] });

      // 2. Normal operation — apply with valid state
      pm.apply(baseState({ proxyPort: 4444 }));
      const resolve = (url: string) => (pm as any).resolveProxy(url);
      expect(resolve("http://100.64.0.5").type).toBe("socks");

      // 3. Simulate disconnect (event page about to suspend)
      pm.apply(baseState({
        hostConnected: false,
        proxyEnabled: false,
        proxyPort: null,
        backendState: "NoState",
      }));

      // Listener must still be registered
      expect(browserProxy.hasListener(pm.listener)).toBe(true);
      // But routes direct because state was cleared
      expect(resolve("http://100.64.0.5").type).toBe("direct");

      // 4. Simulate wake — new instance, restore from storage
      const woken = new FirefoxProxyManager();
      browserProxy.addListener(woken.listener, { urls: ["<all_urls>"] });
      const restored = await woken.restoreFromStorage();
      expect(restored).toBe(true);

      // Restored state routes correctly
      const resolveWoken = (url: string) => (woken as any).resolveProxy(url);
      expect(resolveWoken("http://100.64.0.5").type).toBe("socks");
      expect(resolveWoken("http://100.64.0.5").port).toBe(4444);
      expect(resolveWoken("http://google.com").type).toBe("direct");
    });

    it("listener defers to restore promise during wake, proxies correctly", async () => {
      // Populate storage from a previous session
      pm.apply(baseState({ proxyPort: 3333 }));

      // Simulate wake — new instance, listener registered before restore
      const woken = new FirefoxProxyManager();
      const browserProxy = (globalThis as any).browser.proxy.onRequest;
      browserProxy.addListener(woken.listener, { urls: ["<all_urls>"] });

      // Start restore (but don't await — the listener should defer to it)
      const restorePromise = woken.restoreFromStorage();

      // The first request arrives before restore completes — listener should
      // return a Promise, NOT a synchronous "direct"
      const result = woken.listener({ url: "http://100.64.0.5" });
      expect(result).toBeInstanceOf(Promise);

      // The promise should resolve to the correct proxy info
      const resolved = await result;
      expect(resolved.type).toBe("socks");
      expect((resolved as any).port).toBe(3333);

      await restorePromise;
    });

    it("non-tailscale requests during deferred restore still go direct", async () => {
      pm.apply(baseState({ proxyPort: 3333 }));

      const woken = new FirefoxProxyManager();
      const restorePromise = woken.restoreFromStorage();

      const result = await woken.listener({ url: "http://google.com" });
      expect(result.type).toBe("direct");

      await restorePromise;
    });
  });

  describe("external listener registration", () => {
    it("apply() does not double-register when listener was added externally", () => {
      const browserProxy = (globalThis as any).browser.proxy.onRequest;

      // Simulate entry point registering the listener
      browserProxy.addListener(pm.listener, { urls: ["<all_urls>"] });

      // apply() should not add a second listener
      pm.apply(baseState());
      expect(browserProxy.hasListener(pm.listener)).toBe(true);
    });

    it("apply() with non-proxy state keeps listener but routes direct", () => {
      const browserProxy = (globalThis as any).browser.proxy.onRequest;

      // Simulate entry point registering the listener
      browserProxy.addListener(pm.listener, { urls: ["<all_urls>"] });

      // apply() with stopped state — listener stays, routes direct
      pm.apply(baseState({ backendState: "Stopped" }));
      expect(browserProxy.hasListener(pm.listener)).toBe(true);

      const resolve = (url: string) => (pm as any).resolveProxy(url);
      expect(resolve("http://100.64.0.5").type).toBe("direct");
    });
  });
});
