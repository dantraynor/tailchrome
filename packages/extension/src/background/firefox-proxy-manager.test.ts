import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseState, makePeer } from "@tailchrome/shared/__test__/fixtures";
import { resetSessionStorage } from "../__test__/browser-mock";
import { FirefoxProxyManager } from "./firefox-proxy-manager";
import { policyFromState, RoutingProtection, ROUTING_STORAGE_KEY } from "@tailchrome/shared/background/routing-protection";

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
    vi.restoreAllMocks();
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
    it.each(["tailnet", "only", "bypass"] as const)("routes known DNS names before %s split rules", (mode) => {
      pm.apply(baseState({
        peers: [makePeer({ hostname: "unrelated", dnsName: "wiki.example.ts.net." })],
        dnsRoutes: ["Internal.Example.", "*.invalid"],
        exitNode: mode === "tailnet" ? null : { id: "exit", hostname: "exit", dnsName: "exit.example.ts.net", online: true, location: null },
        domainSplit: { mode: mode === "bypass" ? "bypass" : "only", domains: mode === "bypass" ? ["wiki", "internal.example", "wiki.local", "unrelated", "notinternal.example", "example.com"] : [] },
      }));
      for (const url of ["http://wiki/", "http://WIKI./", "http://internal.example/", "http://app.internal.example/"]) {
        expect(first(pm, url)).toMatchObject({ type: "socks", proxyDNS: true });
      }
      for (const url of ["http://wiki.local/", "http://unrelated/", "http://notinternal.example/", "https://example.com/"]) {
        expect(first(pm, url)).toMatchObject({ type: "direct" });
      }
      pm.apply(baseState({ peers: [], dnsRoutes: [] }));
      expect(first(pm, "http://wiki/")).toMatchObject({ type: "direct" });
      expect(first(pm, "http://internal.example/")).toMatchObject({ type: "direct" });
    });

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

    it.each([false, true])("does not divert traffic into rejected IPv4 routes (explicit policy: %s)", explicit => {
      const subnetCIDRs = ["10.0.0.7/24", "198.51.100.128/25", "0.0.0.0/0", "8.0.0.0/4", "126.0.0.0/7", "169.0.0.0/8", "192.0.0.0/2"];
      const state = baseState({ peers: [makePeer({ subnets: subnetCIDRs })] });
      if (explicit) state.routingPolicy = { ...policyFromState(baseState()), subnetCIDRs };
      pm.apply(state);
      for (const host of ["8.8.8.8", "126.0.0.1", "169.1.0.1", "198.51.100.1", "203.0.113.1"]) {
        expect(first(pm, `http://${host}/`)).toEqual({ type: "direct" });
      }
      for (const host of ["10.0.0.5", "198.51.100.129", "100.64.0.5"]) {
        expect(first(pm, `http://${host}/`)).toMatchObject({ type: "socks", port: 1055 });
      }
    });

    it("still applies exit routing when an IPv4 subnet route is rejected", () => {
      const state = baseState({
        peers: [makePeer({ subnets: ["8.0.0.0/4"] })],
        exitNode: { id: "exit", hostname: "exit", dnsName: "exit.example.ts.net", online: true, location: null },
      });
      pm.apply(state);
      expect(first(pm, "https://8.8.8.8/")).toMatchObject({ type: "socks", port: 1055 });
      state.domainSplit = { mode: "bypass", domains: ["8.8.8.8"] };
      pm.apply(state);
      expect(first(pm, "https://8.8.8.8/")).toEqual({ type: "direct" });
    });

    it("retains legacy IPv4 protection during outages and credential withdrawal", async () => {
      vi.spyOn(chrome.storage.local, "get").mockImplementation(async () => ({ [ROUTING_STORAGE_KEY]: {
        active: { scope: '["","self1"]', selectedExitNodeID: null, magicDNSSuffix: "example.ts.net",
          subnetCIDRs: ["10.0.0.0/24", "8.0.0.0/4"], shortNames: [], dnsRoutes: [],
          domainSplit: { mode: "only", domains: [] } }, profiles: [],
      } }));
      const protection = new RoutingProtection();
      await protection.restore();
      const disconnected = protection.decorate(baseState({ hostConnected: false, proxyPort: null, proxyEnabled: false, backendState: "NoState" }));
      pm.apply(disconnected);
      expect(pm.listener({ url: "https://8.8.8.8/" })).toEqual([
        { type: "socks", host: "127.0.0.1", port: 1, proxyDNS: true }, null,
      ]);
      expect(first(pm, "https://example.com/")).toEqual({ type: "direct" });

      pm.apply(baseState({ routingPolicy: { ...disconnected.routingPolicy!, mode: "active", proxyPort: 1055 } }));
      expect(first(pm, "https://8.8.8.8/")).toEqual({ type: "direct" });
      pm.setProxySession(null);
      expect(pm.listener({ url: "https://8.8.8.8/" })).toEqual([
        { type: "socks", host: "127.0.0.1", port: 1, proxyDNS: true }, null,
      ]);
    });

    it("routes mixed IPv4/IPv6 subnets and exact /100-/128 prefixes", () => {
      pm.apply(baseState({ peers: [makePeer({ subnets: [
        "10.0.0.0/24", "fd00:1:2::/64", "fd00:3::/100", "fd00:4::9/128",
      ] })] }));
      for (const url of ["http://[FD00:1:2::5]/", "http://[fd00:0001:0002:0:0:0:0:0005]/", "http://[fd00:3::ffff]/", "http://[fd00:4::9]/", "http://10.0.0.5/"]) {
        expect(first(pm, url)).toMatchObject({ type: "socks", port: 1055, proxyDNS: true });
      }
      for (const url of ["http://[fd00:1:3::5]/", "http://[fd00:3:0:0:0:0:1000:0]/", "http://[fd00:4::8]/", "http://10.0.1.5/", "https://example.com/"]) {
        expect(first(pm, url)).toEqual({ type: "direct" });
      }
    });

    it("keeps approved IPv6 routes ahead of exit-node only rules", () => {
      pm.apply(baseState({
        peers: [makePeer({ subnets: ["fd00:1:2::/64"] })],
        exitNode: { id: "exit", hostname: "exit", dnsName: "exit.example.ts.net", online: true, location: null },
        domainSplit: { mode: "only", domains: [] },
      }));
      expect(first(pm, "http://[fd00:1:2::5]/")).toMatchObject({ type: "socks", port: 1055 });
      expect(first(pm, "https://example.com/")).toEqual({ type: "direct" });
    });

    it("rejects invalid routes and literal URLs", () => {
      pm.apply(baseState({ peers: [makePeer({ subnets: [
        "fd00:1:2::/64", "::/0", "::1/128", "fe80::/10", "ff00::/8", "::ffff:192.0.2.0/120", "fd00::/129", "fd00::/64junk",
      ] })] }));
      for (const url of ["http://[::1]/", "http://[fe80::1]/", "http://[ff02::1]/", "http://[::ffff:192.0.2.1]/", "http://[fd00:1:2::g]/", "http://[fd00:1:2::1::2]/", "http://[fd00:1:2::5/", "http://[fd00:1:2::5%eth0]/", "http://[fd00:9::1]/"]) {
        expect(first(pm, url)).toEqual({ type: "direct" });
      }
    });

    it("fails closed for restored IPv6 routes without a helper or credential", async () => {
      const subnetCIDRs = ["10.0.0.0/24", "fd00:1:2::/64", "fd00:3::/100", "fd00:4::9/128"];
      vi.spyOn(chrome.storage.local, "get").mockImplementation(async () => ({ [ROUTING_STORAGE_KEY]: {
        active: { scope: '["","self1"]', selectedExitNodeID: null, magicDNSSuffix: "example.ts.net", subnetCIDRs,
          shortNames: [], dnsRoutes: [], domainSplit: { mode: "bypass", domains: [] } }, profiles: [],
      } }));
      const protection = new RoutingProtection();
      await protection.restore();
      pm.setProxySession(null);
      pm.apply(protection.decorate(baseState({ hostConnected: false, proxyPort: null, proxyEnabled: false, backendState: "NoState" })));
      for (const url of ["http://[fd00:1:2::5]/", "http://[fd00:3::ffff]/", "http://[fd00:4::9]/", "http://10.0.0.5/"]) {
        expect(pm.listener({ url })).toEqual([
          { type: "socks", host: "127.0.0.1", port: 1, proxyDNS: true }, null,
        ]);
      }
      expect(first(pm, "https://example.com/")).toEqual({ type: "direct" });
    });
  });

  describe("restricted DNS routing", () => {
    it("uses authoritative DNS routes to replace legacy domains", () => {
      pm.apply(baseState({
        splitDNSDomains: ["old.example.com"],
        dnsRoutes: ["new.example.com"],
      }));
      expect(first(pm, "https://old.example.com/")).toEqual({ type: "direct" });
      expect(first(pm, "https://new.example.com/")).toMatchObject({ type: "socks", port: 1055 });
    });

    it("proxies the domain and descendants with remote DNS and no exit node", () => {
      pm.apply(baseState({ splitDNSDomains: ["Internal.Example.COM."] }));
      for (const host of ["internal.example.com", "srv.internal.example.com", "SRV.Internal.Example.COM."]) {
        expect(first(pm, `https://${host}/`)).toMatchObject({
          type: "socks", port: 1055, proxyDNS: true,
        });
      }
      for (const host of ["notinternal.example.com", "internal.example.com.evil.test", "example.com"]) {
        expect(first(pm, `https://${host}/`)).toEqual({ type: "direct" });
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
        expect(first(pm, "https://srv.internal.example.com/"))
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
      expect(first(pm, "https://example.com/")).toEqual({ type: "direct" });
      expect(first(pm, "https://www.example.com/")).toEqual({ type: "direct" });
    });

    it("replaces restricted domains on each update and clears them when disabled", () => {
      pm.apply(baseState({ splitDNSDomains: ["old.example.com"] }));
      pm.apply(baseState({ splitDNSDomains: ["new.example.com"] }));
      expect(first(pm, "https://old.example.com/")).toEqual({ type: "direct" });
      expect(first(pm, "https://new.example.com/")).toMatchObject({ type: "socks" });

      pm.apply(baseState());
      expect(first(pm, "https://new.example.com/")).toEqual({ type: "direct" });

      pm.apply(baseState({ splitDNSDomains: ["new.example.com"] }));
      pm.clear();
      expect(first(pm, "https://new.example.com/")).toEqual({ type: "direct" });
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
