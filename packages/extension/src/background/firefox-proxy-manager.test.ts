import { beforeEach, describe, expect, it } from "vitest";
import { baseState, makePeer } from "@tailchrome/shared/__test__/fixtures";
import { resetSessionStorage } from "../__test__/browser-mock";
import { FirefoxProxyManager } from "./firefox-proxy-manager";

describe("FirefoxProxyManager", () => {
  let pm: FirefoxProxyManager;

  beforeEach(() => {
    resetSessionStorage();
    pm = new FirefoxProxyManager();
  });

  describe("apply / clear", () => {
    it("sets config when state is running and proxy enabled", () => {
      pm.apply(baseState());
      const browserProxy = (
        globalThis as unknown as {
          browser: {
            proxy: {
              onRequest: {
                hasListener(listener: unknown): boolean;
              };
            };
          };
        }
      ).browser.proxy.onRequest;
      expect(browserProxy.hasListener(pm.listener)).toBe(true);
    });

    it("clear() resets routing state so everything routes direct", () => {
      pm.apply(baseState());
      pm.clear();
      const resolve = (url: string) =>
        (pm as unknown as { resolveProxy(url: string): { type: string } }).resolveProxy(url);

      expect(resolve("http://100.64.0.5").type).toBe("direct");
      expect(resolve("http://100.100.100.100").type).toBe("direct");
    });

    it("clear() does not remove the proxy listener", () => {
      const browserProxy = (
        globalThis as unknown as {
          browser: {
            proxy: {
              onRequest: {
                hasListener(listener: unknown): boolean;
              };
            };
          };
        }
      ).browser.proxy.onRequest;
      pm.apply(baseState());
      expect(browserProxy.hasListener(pm.listener)).toBe(true);

      pm.clear();
      expect(browserProxy.hasListener(pm.listener)).toBe(true);
    });
  });

  describe("routing decisions", () => {
    it("routes Tailscale IPs through proxy, regular sites direct", () => {
      pm.apply(baseState());
      const resolve = (url: string) =>
        (pm as unknown as { resolveProxy(url: string): { type: string; port?: number } }).resolveProxy(url);

      expect(resolve("http://google.com").type).toBe("direct");
      expect(resolve("http://100.64.0.5").type).toBe("socks");
      expect(resolve("http://100.64.0.5").port).toBe(1055);
    });

    it("routes MagicDNS names through proxy", () => {
      pm.apply(baseState());
      const resolve = (url: string) =>
        (pm as unknown as { resolveProxy(url: string): { type: string } }).resolveProxy(url);

      expect(resolve("http://my-server.example.ts.net").type).toBe("socks");
      expect(resolve("http://notexample.ts.net").type).toBe("direct");
    });

    it("routes subnet ranges through proxy", () => {
      pm.apply(
        baseState({
          peers: [makePeer({ subnets: ["10.0.0.0/24", "172.16.0.0/12"] })],
        }),
      );
      const resolve = (url: string) =>
        (pm as unknown as { resolveProxy(url: string): { type: string } }).resolveProxy(url);

      expect(resolve("http://10.0.0.50").type).toBe("socks");
      expect(resolve("http://172.32.0.1").type).toBe("direct");
    });
  });

  describe("session storage persistence", () => {
    it("persists proxy config to session storage on apply", async () => {
      pm.apply(baseState({ proxyPort: 5555 }));

      const restored = new FirefoxProxyManager();
      expect(await restored.restoreFromStorage()).toBe(true);
      expect(
        (
          restored as unknown as {
            proxyPort: number;
            magicDNSSuffix: string;
            reconnectPromise: Promise<void> | null;
          }
        ).proxyPort,
      ).toBe(0);
      expect(
        (
          restored as unknown as {
            proxyPort: number;
            magicDNSSuffix: string;
            reconnectPromise: Promise<void> | null;
          }
        ).magicDNSSuffix,
      ).toBe("example.ts.net");
    });

    it("preserves stored config through the disconnect path", async () => {
      pm.apply(baseState());
      pm.apply(
        baseState({
          hostConnected: false,
          proxyEnabled: false,
          proxyPort: null,
          backendState: "NoState",
        }),
      );

      const restored = new FirefoxProxyManager();
      expect(await restored.restoreFromStorage()).toBe(true);
    });
  });

  describe("listener wake flow", () => {
    it("defers to restore and reconnect promises during wake", async () => {
      pm.apply(baseState({ proxyPort: 3333 }));

      const woken = new FirefoxProxyManager();
      const restorePromise = woken.restoreFromStorage();
      const result = woken.listener({ url: "http://100.64.0.5" });

      expect(result).toBeInstanceOf(Promise);

      await restorePromise;
      woken.apply(baseState({ proxyPort: 4444 }));

      const resolved = await result;
      expect(resolved.type).toBe("socks");
      expect((resolved as { port?: number }).port).toBe(4444);
    });
  });
});
