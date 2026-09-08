import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseState, makePeer } from "@tailchrome/shared/__test__/fixtures";
import type { HelperFailureKind } from "@tailchrome/shared/types";
import { resetSessionStorage } from "../__test__/browser-mock";
import {
  FirefoxProxyManager,
  RECONNECT_GATE_TIMEOUT_MS,
} from "./firefox-proxy-manager";

describe("FirefoxProxyManager", () => {
  let pm: FirefoxProxyManager;

  beforeEach(() => {
    resetSessionStorage();
    pm = new FirefoxProxyManager();
  });

  afterEach(() => {
    vi.useRealTimers();
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

    it("keeps proxy recovery enabled when only the helper version differs", () => {
      pm.apply(
        baseState({
          helperVersionNotice: {
            installedVersion: "0.1.11",
            releaseVersion: "0.1.12",
            relation: "older",
          },
        }),
      );

      expect(pm.listener({ url: "http://100.64.0.5" })).toMatchObject({
        type: "socks",
      });
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

    it("routes Tailscale IPv6 literals through the proxy", () => {
      pm.apply(baseState());
      const resolve = (url: string) =>
        (pm as unknown as { resolveProxy(url: string): { type: string } }).resolveProxy(url);

      expect(resolve("http://[fd7a:115c:a1e0::1234]/").type).toBe("socks");
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

  describe("restricted DNS routing", () => {
    it("proxies the domain and descendants with remote DNS and no exit node", () => {
      pm.apply(baseState({ splitDNSDomains: ["Internal.Example.COM."] }));
      for (const host of ["internal.example.com", "srv.internal.example.com", "SRV.Internal.Example.COM."]) {
        expect(pm.listener({ url: `https://${host}/` })).toMatchObject({
          type: "socks", port: 1055, proxyDNS: true,
        });
      }
      for (const host of ["notinternal.example.com", "internal.example.com.evil.test", "example.com"]) {
        expect(pm.listener({ url: `https://${host}/` })).toEqual({ type: "direct" });
      }
    });

    it.each(["bypass", "only"] as const)(
      "restricted DNS takes priority over exit-node %s rules", (mode) => {
        pm.apply(baseState({
          splitDNSDomains: ["internal.example.com"],
          exitNode: {
            id: "exit1", hostname: "exit", dnsName: "exit.example.ts.net.",
            location: null, online: true,
          },
          domainSplit: { mode, domains: mode === "bypass" ? ["internal.example.com"] : [] },
        }));
        expect(pm.listener({ url: "https://srv.internal.example.com/" }))
          .toMatchObject({ type: "socks", proxyDNS: true });
      },
    );

    it("rejects malformed suffixes without broadening proxy routing", () => {
      pm.apply(baseState({
        splitDNSDomains: [
          ".", "https://example.com", "example.com/path", "example.com:53",
          ".example.com", "example..com", "-bad.example.com", 'evil\"); return \"DIRECT\"; //',
        ],
      }));
      expect(pm.listener({ url: "https://example.com/" })).toEqual({ type: "direct" });
      expect(pm.listener({ url: "https://www.example.com/" })).toEqual({ type: "direct" });
    });

    it("replaces restricted domains on each update and clears them when disabled", () => {
      pm.apply(baseState({ splitDNSDomains: ["old.example.com"] }));
      pm.apply(baseState({ splitDNSDomains: ["new.example.com"] }));
      expect(pm.listener({ url: "https://old.example.com/" })).toEqual({ type: "direct" });
      expect(pm.listener({ url: "https://new.example.com/" })).toMatchObject({ type: "socks" });

      pm.apply(baseState());
      expect(pm.listener({ url: "https://new.example.com/" })).toEqual({ type: "direct" });

      pm.apply(baseState({ splitDNSDomains: ["new.example.com"] }));
      pm.clear();
      expect(pm.listener({ url: "https://new.example.com/" })).toEqual({ type: "direct" });
      expect((pm as unknown as { splitDNSDomains: string[] }).splitDNSDomains).toEqual([]);
    });
  });

  describe("session storage persistence", () => {
    it("restores restricted domains and waits for current host status before routing", async () => {
      pm.apply(baseState({ splitDNSDomains: ["Internal.Example.COM."] }));
      const restored = new FirefoxProxyManager();
      expect(await restored.restoreFromStorage()).toBe(true);
      expect((restored as unknown as { splitDNSDomains: string[] }).splitDNSDomains)
        .toEqual(["internal.example.com"]);
      const request = restored.listener({ url: "https://srv.internal.example.com/" });
      expect(request).toBeInstanceOf(Promise);
      restored.apply(baseState({ proxyPort: 4444, splitDNSDomains: ["internal.example.com"] }));
      await expect(request).resolves.toMatchObject({ type: "socks", port: 4444, proxyDNS: true });
    });

    it("uses refreshed restricted domains for requests held during restoration", async () => {
      pm.apply(baseState({ splitDNSDomains: ["old.example.com"] }));
      const restored = new FirefoxProxyManager();
      await restored.restoreFromStorage();
      const oldRequest = restored.listener({ url: "https://old.example.com/" });
      const newRequest = restored.listener({ url: "https://new.example.com/" });
      restored.apply(baseState({ splitDNSDomains: ["new.example.com"] }));
      await expect(oldRequest).resolves.toEqual({ type: "direct" });
      await expect(newRequest).resolves.toMatchObject({ type: "socks", proxyDNS: true });
    });

    it.each([undefined, ["Internal.Example.COM.", ".", "https://example.com", 42]])(
      "validates restored domains and supports stored configs without them: %j", async (splitDNSDomains) => {
        const session = (globalThis as unknown as {
          browser: { storage: { session: { set(items: Record<string, unknown>): Promise<void> } } };
        }).browser.storage.session;
        await session.set({ proxyConfig: {
          proxyPort: 1055, magicDNSSuffix: "example.ts.net", exitNodeActive: false,
          subnetRanges: [], splitMode: "bypass", splitDomains: [],
          ...(splitDNSDomains === undefined ? {} : { splitDNSDomains }),
        } });
        expect(await pm.restoreFromStorage()).toBe(true);
        expect((pm as unknown as { splitDNSDomains: string[] }).splitDNSDomains)
          .toEqual(splitDNSDomains === undefined ? [] : ["internal.example.com"]);
        pm.clear();
      },
    );

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
      restored.clear();
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
      restored.clear();
      pm.clear();
    });
  });

  describe("split tunneling rules", () => {
    const withExit = (overrides: Record<string, unknown> = {}) =>
      baseState({
        exitNode: {
          id: "exit1",
          hostname: "exit",
          dnsName: "exit.example.ts.net.",
          location: null,
          online: true,
        },
        ...overrides,
      });
    const resolveOf = (manager: FirefoxProxyManager) =>
      (url: string) =>
        (manager as unknown as { resolveProxy(url: string): { type: string } }).resolveProxy(url);

    it("bypass mode: listed domain goes direct, others go through proxy", () => {
      pm.apply(
        withExit({
          domainSplit: { mode: "bypass", domains: ["teams.microsoft.com"] },
        }),
      );
      const resolve = resolveOf(pm);
      expect(resolve("https://teams.microsoft.com/").type).toBe("direct");
      expect(resolve("https://x.teams.microsoft.com/").type).toBe("direct");
      expect(resolve("https://example.com/").type).toBe("socks");
    });

    it("only mode: listed domain goes through proxy, others go direct", () => {
      pm.apply(
        withExit({
          domainSplit: { mode: "only", domains: ["work.example.com"] },
        }),
      );
      const resolve = resolveOf(pm);
      expect(resolve("https://work.example.com/").type).toBe("socks");
      expect(resolve("https://google.com/").type).toBe("direct");
    });

    it("only mode with empty list: catch-all is direct", () => {
      pm.apply(withExit({ domainSplit: { mode: "only", domains: [] } }));
      const resolve = resolveOf(pm);
      expect(resolve("https://example.com/").type).toBe("direct");
      expect(resolve("https://google.com/").type).toBe("direct");
      // Tailscale-mandatory traffic still proxies.
      expect(resolve("http://100.100.100.100/").type).toBe("socks");
      expect(resolve("http://srv.example.ts.net/").type).toBe("socks");
    });

    it("bypass mode with empty list: catch-all is proxy", () => {
      pm.apply(withExit({ domainSplit: { mode: "bypass", domains: [] } }));
      const resolve = resolveOf(pm);
      expect(resolve("https://example.com/").type).toBe("socks");
    });

    it("only mode still routes Tailscale-mandatory traffic through proxy", () => {
      pm.apply(
        withExit({
          domainSplit: { mode: "only", domains: ["work.example.com"] },
        }),
      );
      const resolve = resolveOf(pm);
      expect(resolve("http://100.100.100.100/").type).toBe("socks");
      expect(resolve("http://srv.example.ts.net/").type).toBe("socks");
    });

    it("rules are inert when no exit node is active", () => {
      pm.apply(
        baseState({
          domainSplit: { mode: "bypass", domains: ["teams.microsoft.com"] },
        }),
      );
      const resolve = resolveOf(pm);
      expect(resolve("https://teams.microsoft.com/").type).toBe("direct");
      expect(resolve("https://example.com/").type).toBe("direct");
    });

    it("ignores invalid domain entries", () => {
      pm.apply(
        withExit({
          domainSplit: {
            mode: "bypass",
            domains: ['evil"); alert("xss', "ok.example.com"],
          },
        }),
      );
      const resolve = resolveOf(pm);
      expect(resolve("https://ok.example.com/").type).toBe("direct");
      expect(resolve("https://other.com/").type).toBe("socks");
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

    it("keeps requests held through transient NoState updates", async () => {
      pm.apply(baseState({ proxyPort: 3333 }));

      const woken = new FirefoxProxyManager();
      await woken.restoreFromStorage();
      const result = woken.listener({ url: "http://100.64.0.5" });
      expect(result).toBeInstanceOf(Promise);

      woken.apply(
        baseState({
          hostConnected: false,
          proxyEnabled: false,
          proxyPort: null,
          backendState: "NoState",
        }),
      );
      let settled = false;
      void Promise.resolve(result).then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      woken.apply(baseState({ proxyPort: 4444 }));
      await expect(result).resolves.toMatchObject({ type: "socks", port: 4444 });
    });

    it("releases held requests on an authoritative stopped state", async () => {
      pm.apply(baseState({ proxyPort: 3333 }));

      const woken = new FirefoxProxyManager();
      await woken.restoreFromStorage();
      const result = woken.listener({ url: "http://100.64.0.5" });
      woken.apply(
        baseState({
          hostConnected: true,
          proxyEnabled: false,
          proxyPort: null,
          backendState: "Stopped",
        }),
      );

      await expect(result).resolves.toMatchObject({ type: "direct" });
    });
  });

  describe("reconnect gate escape hatches", () => {
    const transientDisconnect = () =>
      baseState({
        hostConnected: false,
        proxyEnabled: false,
        proxyPort: null,
        backendState: "NoState" as const,
      });

    it("fails open when the helper does not return before the gate deadline", async () => {
      vi.useFakeTimers();
      pm.apply(baseState({ proxyPort: 3333 }));

      const woken = new FirefoxProxyManager();
      await woken.restoreFromStorage();
      const result = woken.listener({ url: "http://100.64.0.5" });
      expect(result).toBeInstanceOf(Promise);

      vi.advanceTimersByTime(RECONNECT_GATE_TIMEOUT_MS);
      await expect(result).resolves.toMatchObject({ type: "direct" });

      // The stored config is wiped so a later event-page restart cannot
      // re-gate on it, and further transient updates do not re-arm the gate.
      const restored = new FirefoxProxyManager();
      expect(await restored.restoreFromStorage()).toBe(false);
      woken.apply(transientDisconnect());
      expect(
        (woken as unknown as { reconnectPromise: Promise<void> | null })
          .reconnectPromise,
      ).toBeNull();
      await expect(
        Promise.resolve(woken.listener({ url: "http://100.64.0.5" })),
      ).resolves.toMatchObject({ type: "direct" });
    });

    it("cancels the gate deadline once the proxy config is reapplied", async () => {
      vi.useFakeTimers();
      pm.apply(baseState({ proxyPort: 3333 }));

      const woken = new FirefoxProxyManager();
      await woken.restoreFromStorage();
      const result = woken.listener({ url: "http://100.64.0.5" });

      woken.apply(baseState({ proxyPort: 4444 }));
      vi.advanceTimersByTime(RECONNECT_GATE_TIMEOUT_MS);

      await expect(result).resolves.toMatchObject({
        type: "socks",
        port: 4444,
      });
      // The canceled deadline must not wipe the live or stored config.
      expect(
        (woken as unknown as { resolveProxy(url: string): { type: string } })
          .resolveProxy("http://100.64.0.5").type,
      ).toBe("socks");
      const restored = new FirefoxProxyManager();
      expect(await restored.restoreFromStorage()).toBe(true);
    });

    it.each([
      "helper-unavailable",
      "helper-not-allowed",
      "helper-reported-error",
      "helper-incompatible",
    ] satisfies HelperFailureKind[])(
      "releases held requests for authoritative %s failures",
      async (kind) => {
      pm.apply(baseState({ proxyPort: 3333 }));

      const woken = new FirefoxProxyManager();
      await woken.restoreFromStorage();
      const result = woken.listener({ url: "http://100.64.0.5" });

        woken.apply({
          ...transientDisconnect(),
          helperFailure: {
            kind,
            diagnosticCode: "fixture-authoritative-failure",
            diagnosticMessage: null,
          },
        });

      await expect(result).resolves.toMatchObject({ type: "direct" });
      const restored = new FirefoxProxyManager();
      expect(await restored.restoreFromStorage()).toBe(false);
      },
    );

    it.each([
      "helper-start-failed",
      "helper-stopped",
    ] satisfies HelperFailureKind[])(
      "keeps held requests behind the reconnect deadline for transient %s",
      async (kind) => {
        pm.apply(baseState({ proxyPort: 3333 }));

        const woken = new FirefoxProxyManager();
        await woken.restoreFromStorage();
        const result = woken.listener({ url: "http://100.64.0.5" });
        woken.apply({
          ...transientDisconnect(),
          reconnecting: true,
          helperFailure: {
            kind,
            diagnosticCode: "fixture-transient-failure",
            diagnosticMessage: null,
          },
        });

        woken.apply(baseState({ proxyPort: 4444 }));
        await expect(result).resolves.toMatchObject({
          type: "socks",
          port: 4444,
        });
      },
    );
  });
});
