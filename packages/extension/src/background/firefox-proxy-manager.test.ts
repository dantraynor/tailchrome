import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseState, makePeer } from "@tailchrome/shared/__test__/fixtures";
import { resetSessionStorage } from "../__test__/browser-mock";
import { FirefoxProxyManager } from "./firefox-proxy-manager";

function first(pm: FirefoxProxyManager, url: string) {
  const result = pm.listener({ url });
  return Array.isArray(result) ? result[0] : result;
}

describe("FirefoxProxyManager", () => {
  let pm: FirefoxProxyManager;

  beforeEach(() => {
    resetSessionStorage();
    pm = new FirefoxProxyManager();
    pm.setProxySession({ port: 1055, username: "fixture", password: "fixture-credential-".repeat(3) });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("apply / clear", () => {
    it("blocks without credentials and after an active session is revoked", () => {
      pm.setProxySession(null);
      pm.apply(baseState());
      expect(pm.listener({ url: "http://100.64.0.2/" })).toEqual([
        { type: "socks", host: "127.0.0.1", port: 1, proxyDNS: true }, null,
      ]);
      pm.setProxySession({ port: 1055, username: "fixture", password: "fixture-credential-".repeat(3) });
      pm.apply(baseState());
      expect(first(pm, "http://100.64.0.2/").port).toBe(1055);
      pm.setProxySession(null);
      expect(pm.listener({ url: "http://100.64.0.2/" })).toEqual([
        { type: "socks", host: "127.0.0.1", port: 1, proxyDNS: true }, null,
      ]);
    });

    it("uses credentials only for the matching helper port and never persists them", async () => {
      const password = "private-credential-".repeat(3);
      pm.setProxySession({ port: 1055, username: "user", password });
      pm.apply(baseState());
      expect(first(pm, "http://100.64.0.2/")).toMatchObject({ username: "user", password });
      const stored = await (globalThis as any).browser.storage.session.get("proxyConfig");
      expect(JSON.stringify(stored)).not.toContain(password);
      pm.setProxySession(null);
      expect(first(pm, "http://100.64.0.2/")).not.toHaveProperty("password");
    });

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

      expect(first(pm, "http://100.64.0.5")).toMatchObject({
        type: "socks",
      });
    });

    it("clear() resets routing state so everything routes direct", () => {
      pm.apply(baseState());
      pm.clear();
      const resolve = (url: string) => first(pm, url);

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
      const resolve = (url: string) => first(pm, url);

      expect(resolve("http://google.com").type).toBe("direct");
      expect(resolve("http://100.64.0.5").type).toBe("socks");
      expect(resolve("http://100.64.0.5").port).toBe(1055);
    });

    it("routes MagicDNS names through proxy", () => {
      pm.apply(baseState());
      const resolve = (url: string) => first(pm, url);

      expect(resolve("http://my-server.example.ts.net").type).toBe("socks");
      expect(resolve("http://notexample.ts.net").type).toBe("direct");
    });

    it("routes Tailscale IPv6 literals through the proxy", () => {
      pm.apply(baseState());
      const resolve = (url: string) => first(pm, url);

      expect(resolve("http://[fd7a:115c:a1e0::1234]/").type).toBe("socks");
    });

    it("routes subnet ranges through proxy", () => {
      pm.apply(
        baseState({
          peers: [makePeer({ subnets: ["10.0.0.0/24", "172.16.0.0/12"] })],
        }),
      );
      const resolve = (url: string) => first(pm, url);

      expect(resolve("http://10.0.0.50").type).toBe("socks");
      expect(resolve("http://172.32.0.1").type).toBe("direct");
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
    const resolveOf = (manager: FirefoxProxyManager) => (url: string) =>
      first(manager, url);

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

  it("blocks requests before routing restoration completes", () => {
    expect(pm.listener({ url: "https://example.com/" })).toEqual([
      { type: "socks", host: "127.0.0.1", port: 1, proxyDNS: true },
      null,
    ]);
  });

  it("terminates protected proxy chains without browser fallback", () => {
    pm.apply(baseState());
    expect(pm.listener({ url: "https://100.64.0.5/" })).toEqual([
      { type: "socks", host: "127.0.0.1", port: 1055, proxyDNS: true, username: "fixture", password: "fixture-credential-".repeat(3) },
      null,
    ]);
  });

  it("keeps protected traffic blocked after ten seconds", () => {
    vi.useFakeTimers();
    pm.apply(
      baseState({
        prefs: {
          exitNodeID: "missing",
          exitNodeAllowLANAccess: false,
          corpDNS: true,
          shieldsUp: false,
        },
      }),
    );
    vi.advanceTimersByTime(60_000);
    expect(first(pm, "https://example.com/").port).toBe(1);
  });
});
