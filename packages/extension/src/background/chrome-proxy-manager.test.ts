import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseState, makePeer } from "@tailchrome/shared/__test__/fixtures";
import type { TailscaleState } from "@tailchrome/shared/types";
import { ChromeProxyManager } from "./chrome-proxy-manager";

function capturePAC(
  pm: ChromeProxyManager,
  state: TailscaleState,
): string | null {
  let captured: string | null = null;
  const original = chrome.proxy.settings.set;

  chrome.proxy.settings.set = ((details: unknown, cb?: () => void) => {
    const typedDetails = details as {
      value?: { pacScript?: { data?: string } };
    };
    captured = typedDetails.value?.pacScript?.data ?? null;
    cb?.();
    return Promise.resolve();
  }) as typeof chrome.proxy.settings.set;

  pm.apply(state);
  chrome.proxy.settings.set = original;
  return captured;
}

describe("ChromeProxyManager", () => {
  let pm: ChromeProxyManager;

  beforeEach(() => {
    pm = new ChromeProxyManager();
    pm.setProxySession({ port: 1055, username: "fixture", password: "fixture-credential-".repeat(3) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("apply", () => {
    it("blocks the protected policy without a matching authenticated session", () => {
      pm.setProxySession(null);
      const report = vi.fn();
      pm.setRoutingHealthListener(report);
      const set = vi.spyOn(chrome.proxy.settings, "set");
      pm.apply(baseState());
      const pac = (set.mock.calls.at(-1)![0].value as chrome.proxy.ProxyConfig).pacScript!.data!;
      expect(pac).toContain("PROXY 127.0.0.1:1");
      expect(pac).not.toContain("PROXY 127.0.0.1:1055");
      expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ status: "blocked" }));
      pm.setProxySession({ port: 1055, username: "fixture", password: "fixture-credential-".repeat(3) });
      pm.apply(baseState());
      expect((set.mock.calls.at(-1)![0].value as chrome.proxy.ProxyConfig).pacScript!.data).toContain("PROXY 127.0.0.1:1055");
      expect(report).toHaveBeenLastCalledWith({ status: "active", message: "" });
    });

    it("sets proxy when state is running and proxy enabled", () => {
      const spy = vi.spyOn(chrome.proxy.settings, "set");
      pm.apply(baseState());
      expect(spy).toHaveBeenCalled();
      const args = spy.mock.calls[0]![0] as { value: { mode: string } };
      expect(args.value.mode).toBe("pac_script");
    });

    it("releases its proxy setting after an explicit direct policy", () => {
      const spy = vi.spyOn(chrome.proxy.settings, "clear");
      pm.apply(baseState());
      pm.apply(baseState({ backendState: "Stopped" }));
      expect(spy).toHaveBeenCalledWith(
        { scope: "regular" },
        expect.any(Function),
      );
    });

    it("makes PAC mandatory", () => {
      const spy = vi.spyOn(chrome.proxy.settings, "set");
      pm.apply(baseState());
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          value: expect.objectContaining({
            pacScript: expect.objectContaining({ mandatory: true }),
          }),
        }),
        expect.any(Function),
      );
    });
  });

  describe("PAC script generation", () => {
    it.each(["tailnet", "only", "bypass"] as const)("routes known DNS names before %s split rules", (mode) => {
      const state = baseState({
        peers: [makePeer({ hostname: "unrelated", dnsName: "wiki.example.ts.net." })],
        dnsRoutes: ["Internal.Example.", "*.invalid", 'bad\";'],
        exitNode: mode === "tailnet" ? null : { id: "exit", hostname: "exit", dnsName: "exit.example.ts.net", online: true, location: null },
        domainSplit: { mode: mode === "bypass" ? "bypass" : "only", domains: mode === "bypass" ? ["wiki", "internal.example", "wiki.local", "unrelated", "notinternal.example", "example.com"] : [] },
      });
      const route = evalPAC(pm, state);
      expect(route("http://wiki/", "wiki")).toContain("PROXY");
      expect(route("http://wiki/", "WIKI.")).toContain("PROXY");
      expect(route("http://wiki.local/", "wiki.local")).toBe("DIRECT");
      expect(route("http://unrelated/", "unrelated")).toBe("DIRECT");
      expect(route("http://internal.example/", "internal.example")).toContain("PROXY");
      expect(route("http://app.internal.example/", "app.internal.example")).toContain("PROXY");
      expect(route("http://notinternal.example/", "notinternal.example")).toBe("DIRECT");
      expect(route("https://example.com/", "example.com")).toBe("DIRECT");
      expect(capturePAC(pm, { ...state, dnsRoutes: [], peers: [] })).not.toBeNull();
    });

    it("always proxies the Tailscale service IP", () => {
      const pac = capturePAC(pm, baseState())!;
      expect(pac).toContain('host === "100.100.100.100"');
    });

    it("proxies CGNAT range", () => {
      const pac = capturePAC(pm, baseState())!;
      expect(pac).toContain('isInNet(host, "100.64.0.0", "255.192.0.0")');
    });

    it("proxies MagicDNS names", () => {
      const pac = capturePAC(pm, baseState())!;
      expect(pac).toContain('dnsDomainIs(host, ".example.ts.net")');
    });

    it("returns DIRECT when no exit node is active", () => {
      const pac = capturePAC(pm, baseState())!;
      expect(pac).toContain('return "DIRECT"');
      expect(pac).not.toMatch(/return proxy;\s*\n\s*}$/);
    });

    it("proxies all traffic when exit node is active", () => {
      const state = baseState({
        exitNode: {
          id: "exit1",
          hostname: "exit-node",
          dnsName: "exit-node.example.ts.net.",
          location: null,
          online: true,
        },
      });
      const pac = capturePAC(pm, state)!;
      expect(pac).toMatch(/return proxy;\s*\n\s*}$/);
    });

    it("includes subnet routes from peers", () => {
      const state = baseState({
        peers: [makePeer({ subnets: ["10.0.0.0/24", "192.168.1.0/16"] })],
      });
      const pac = capturePAC(pm, state)!;
      expect(pac).toContain('isInNet(host, "10.0.0.0", "255.255.255.0")');
      expect(pac).toContain('isInNet(host, "192.168.1.0", "255.255.0.0")');
    });

    it("skips non-subnet-router peers", () => {
      const state = baseState({
        peers: [makePeer({ isSubnetRouter: false })],
      });
      const pac = capturePAC(pm, state)!;
      const subnetSection = pac.split("// No subnet routes")[0]!;
      expect(subnetSection).not.toContain('isInNet(host, "10.');
    });

    it("sanitizes unsafe MagicDNS suffix characters", () => {
      const state = baseState({ magicDNSSuffix: 'evil"); alert("xss' });
      const pac = capturePAC(pm, state)!;
      expect(pac).not.toContain("evil");
      expect(pac).toContain("// No MagicDNS suffix configured");
    });

    it("strips trailing dot from MagicDNS suffix", () => {
      const state = baseState({ magicDNSSuffix: "example.ts.net." });
      const pac = capturePAC(pm, state)!;
      expect(pac).toContain('dnsDomainIs(host, ".example.ts.net")');
      expect(pac).not.toContain("example.ts.net.");
    });

    it("handles null MagicDNS suffix", () => {
      const pac = capturePAC(pm, baseState({ magicDNSSuffix: null }))!;
      expect(pac).toContain("// No MagicDNS suffix configured");
    });
  });

  describe("PAC script routing decisions", () => {
    it("routes Tailscale IPs through proxy, regular sites DIRECT", () => {
      const route = evalPAC(pm, baseState());
      expect(route("http://google.com", "google.com")).toBe("DIRECT");
      expect(route("http://100.64.0.5", "100.64.0.5")).toBe(
        "PROXY 127.0.0.1:1055",
      );
      expect(route("http://100.100.100.100", "100.100.100.100")).toBe(
        "PROXY 127.0.0.1:1055",
      );
      expect(route("http://100.127.255.255", "100.127.255.255")).toBe(
        "PROXY 127.0.0.1:1055",
      );
    });

    it("routes MagicDNS names through proxy", () => {
      const route = evalPAC(pm, baseState());
      expect(
        route("http://my-server.example.ts.net", "my-server.example.ts.net"),
      ).toBe("PROXY 127.0.0.1:1055");
      expect(route("http://example.ts.net", "example.ts.net")).toBe(
        "PROXY 127.0.0.1:1055",
      );
      expect(route("http://notexample.ts.net", "notexample.ts.net")).toBe(
        "DIRECT",
      );
    });

    it("routes Tailscale IPv6 literals through the proxy", () => {
      const route = evalPAC(pm, baseState());
      expect(
        route("http://[fd7a:115c:a1e0::1234]/", "fd7a:115c:a1e0::1234"),
      ).toBe("PROXY 127.0.0.1:1055");
    });

    it("never calls isInNet for a DNS hostname", () => {
      const pac = capturePAC(pm, baseState())!;
      const isInNet = (host: string): boolean => {
        if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
          throw new Error("isInNet attempted DNS resolution");
        }
        return false;
      };
      const dnsDomainIs = (host: string, suffix: string): boolean =>
        host === suffix.slice(1) || host.endsWith(suffix);
      const fn = new Function(
        "isInNet",
        "dnsDomainIs",
        `${pac}\nreturn FindProxyForURL;`,
      )(isInNet, dnsDomainIs) as (url: string, host: string) => string;

      expect(fn("https://example.com", "example.com")).toBe("DIRECT");
    });

    it("routes everything through proxy when exit node is active", () => {
      const route = evalPAC(
        pm,
        baseState({
          exitNode: {
            id: "exit1",
            hostname: "exit",
            dnsName: "exit.example.ts.net.",
            location: null,
            online: true,
          },
        }),
      );
      expect(route("http://google.com", "google.com")).toBe(
        "PROXY 127.0.0.1:1055",
      );
      expect(route("http://192.168.1.1", "192.168.1.1")).toBe(
        "PROXY 127.0.0.1:1055",
      );
    });

    it("routes subnet ranges through proxy", () => {
      const route = evalPAC(
        pm,
        baseState({
          peers: [makePeer({ subnets: ["10.0.0.0/24", "172.16.0.0/12"] })],
        }),
      );
      expect(route("http://10.0.0.50", "10.0.0.50")).toBe(
        "PROXY 127.0.0.1:1055",
      );
      expect(route("http://172.20.5.1", "172.20.5.1")).toBe(
        "PROXY 127.0.0.1:1055",
      );
      expect(route("http://10.0.1.1", "10.0.1.1")).toBe("DIRECT");
      expect(route("http://172.32.0.1", "172.32.0.1")).toBe("DIRECT");
    });
  });

  describe("split tunneling rules", () => {
    const withExit = (overrides: Partial<TailscaleState> = {}) =>
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

    it("bypass mode: listed domain goes DIRECT, others use exit node", () => {
      const route = evalPAC(
        pm,
        withExit({
          domainSplit: { mode: "bypass", domains: ["teams.microsoft.com"] },
        }),
      );
      expect(route("https://teams.microsoft.com/", "teams.microsoft.com")).toBe(
        "DIRECT",
      );
      expect(
        route("https://x.teams.microsoft.com/", "x.teams.microsoft.com"),
      ).toBe("DIRECT");
      expect(route("https://example.com/", "example.com")).toBe(
        "PROXY 127.0.0.1:1055",
      );
    });

    it("only mode: listed domain uses exit node, others go DIRECT", () => {
      const route = evalPAC(
        pm,
        withExit({
          domainSplit: { mode: "only", domains: ["work.example.com"] },
        }),
      );
      expect(route("https://work.example.com/", "work.example.com")).toBe(
        "PROXY 127.0.0.1:1055",
      );
      expect(route("https://google.com/", "google.com")).toBe("DIRECT");
    });

    it("only mode: Tailscale-mandatory traffic still routes through proxy", () => {
      const route = evalPAC(
        pm,
        withExit({
          domainSplit: { mode: "only", domains: ["work.example.com"] },
        }),
      );
      expect(route("http://100.100.100.100", "100.100.100.100")).toBe(
        "PROXY 127.0.0.1:1055",
      );
      expect(route("http://srv.example.ts.net", "srv.example.ts.net")).toBe(
        "PROXY 127.0.0.1:1055",
      );
    });

    it("only mode with empty list: catch-all is DIRECT", () => {
      const route = evalPAC(
        pm,
        withExit({ domainSplit: { mode: "only", domains: [] } }),
      );
      expect(route("https://example.com/", "example.com")).toBe("DIRECT");
      expect(route("https://google.com/", "google.com")).toBe("DIRECT");
      // Tailscale-mandatory traffic still proxies.
      expect(route("http://100.100.100.100", "100.100.100.100")).toBe(
        "PROXY 127.0.0.1:1055",
      );
      expect(route("http://srv.example.ts.net", "srv.example.ts.net")).toBe(
        "PROXY 127.0.0.1:1055",
      );
    });

    it("bypass mode with empty list: catch-all is full proxy (no rules to apply)", () => {
      const route = evalPAC(
        pm,
        withExit({ domainSplit: { mode: "bypass", domains: [] } }),
      );
      expect(route("https://example.com/", "example.com")).toBe(
        "PROXY 127.0.0.1:1055",
      );
    });

    it("rules are inert when no exit node is active", () => {
      const route = evalPAC(
        pm,
        baseState({
          domainSplit: { mode: "bypass", domains: ["teams.microsoft.com"] },
        }),
      );
      expect(route("https://teams.microsoft.com/", "teams.microsoft.com")).toBe(
        "DIRECT",
      );
      expect(route("https://example.com/", "example.com")).toBe("DIRECT");
    });

    it("regenerates PAC when domainSplit changes", () => {
      const spy = vi.spyOn(chrome.proxy.settings, "set");
      pm.apply(withExit());
      const callsBefore = spy.mock.calls.length;
      pm.apply(
        withExit({
          domainSplit: { mode: "bypass", domains: ["teams.microsoft.com"] },
        }),
      );
      expect(spy.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it("drops invalid domains before embedding in PAC", () => {
      const pac = capturePAC(
        pm,
        withExit({
          domainSplit: {
            mode: "bypass",
            domains: ['evil"); alert("xss', "ok.example.com"],
          },
        }),
      )!;
      expect(pac).not.toContain("evil");
      expect(pac).toContain('"ok.example.com"');
    });
  });
  it("does not cache a rejected configuration and retries the next application", () => {
    const report = vi.fn();
    pm.setRoutingHealthListener(report);
    const original = chrome.proxy.settings.set;
    const set = vi
      .spyOn(chrome.proxy.settings, "set")
      .mockImplementationOnce((_details, callback) => {
        Object.assign(chrome.runtime, { lastError: { message: "rejected" } });
        callback?.();
        Object.assign(chrome.runtime, { lastError: undefined });
        return Promise.resolve();
      });
    pm.apply(baseState());
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "unavailable" }),
    );
    set.mockImplementation(original);
    pm.apply(baseState());
    expect(set).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith({ status: "active", message: "" });
  });

  it("reports ownership conflicts without claiming an active route", () => {
    const report = vi.fn();
    pm.setRoutingHealthListener(report);
    vi.spyOn(chrome.proxy.settings, "get").mockImplementation(
      (_details, callback) => {
        callback({
          levelOfControl: "controlled_by_other_extensions",
          value: { mode: "direct" },
        });
        return Promise.resolve({});
      },
    );
    const set = vi.spyOn(chrome.proxy.settings, "set");
    pm.apply(baseState());
    expect(set).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "conflicted" }),
    );
  });

  it("keeps proxy errors visible through reentrant state notifications", () => {
    let onError:
      | ((details: { error: string; details: string; fatal: boolean }) => void)
      | undefined;
    vi.spyOn(chrome.proxy.onProxyError, "addListener").mockImplementation(
      (listener) => {
        onError = listener;
      },
    );
    const manager = new ChromeProxyManager();
    manager.setProxySession({ port: 1055, username: "fixture", password: "fixture-credential-".repeat(3) });
    const reports: string[] = [];
    manager.setRoutingHealthListener((health) => {
      reports.push(health.status);
      if (health.status === "blocked") manager.apply(baseState());
    });
    manager.apply(baseState());
    onError?.({ error: "connection failed", details: "", fatal: true });
    expect(reports.at(-1)).toBe("blocked");
  });

  it("recovers the original route after an error and an intervening blocked policy", () => {
    let onError:
      | ((details: { error: string; details: string; fatal: boolean }) => void)
      | undefined;
    vi.spyOn(chrome.proxy.onProxyError, "addListener").mockImplementation(
      (listener) => {
        onError = listener;
      },
    );
    const manager = new ChromeProxyManager();
    manager.setProxySession({ port: 1055, username: "fixture", password: "fixture-credential-".repeat(3) });
    const report = vi.fn();
    manager.setRoutingHealthListener(report);
    manager.apply(baseState());
    onError?.({ error: "failed", details: "", fatal: true });
    manager.apply(
      baseState({
        prefs: {
          exitNodeID: "missing",
          corpDNS: true,
          shieldsUp: false,
          exitNodeAllowLANAccess: false,
        },
      }),
    );
    manager.apply(baseState());
    expect(report).toHaveBeenLastCalledWith({ status: "active", message: "" });
  });

  it("accepts Chrome's canonical PAC property order", () => {
    let value: chrome.proxy.ProxyConfig = { mode: "system" };
    vi.spyOn(chrome.proxy.settings, "set").mockImplementation(
      (details, callback) => {
        const config = details.value as chrome.proxy.ProxyConfig;
        value = {
          mode: config.mode,
          pacScript: { data: config.pacScript?.data, mandatory: true },
        };
        callback?.();
        return Promise.resolve();
      },
    );
    vi.spyOn(chrome.proxy.settings, "get").mockImplementation(
      (_details, callback) => {
        callback({ value, levelOfControl: "controlled_by_this_extension" });
        return Promise.resolve({});
      },
    );
    const health = vi.fn();
    pm.setRoutingHealthListener(health);
    pm.apply(baseState());
    expect(health).toHaveBeenLastCalledWith({ status: "active", message: "" });
  });
});

function evalPAC(
  pm: ChromeProxyManager,
  state: TailscaleState,
): (url: string, host: string) => string {
  const pac = capturePAC(pm, state);
  if (!pac) throw new Error("No PAC script generated");

  const isInNet = (host: string, network: string, mask: string): boolean => {
    const toNum = (ip: string) =>
      ip.split(".").reduce((acc, octet) => (acc << 8) | Number(octet), 0) >>> 0;
    return (toNum(host) & toNum(mask)) === (toNum(network) & toNum(mask));
  };

  const dnsDomainIs = (host: string, suffix: string): boolean =>
    host === suffix.slice(1) || host.endsWith(suffix);

  const fn = new Function(
    "isInNet",
    "dnsDomainIs",
    `${pac}\nreturn FindProxyForURL;`,
  );
  return fn(isInNet, dnsDomainIs) as (url: string, host: string) => string;
}
