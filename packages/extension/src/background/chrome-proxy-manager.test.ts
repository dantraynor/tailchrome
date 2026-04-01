import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseState, makePeer } from "@tailchrome/shared/__test__/fixtures";
import type { TailscaleState } from "@tailchrome/shared/types";
import { ChromeProxyManager } from "./chrome-proxy-manager";

function capturePAC(pm: ChromeProxyManager, state: TailscaleState): string | null {
  let captured: string | null = null;
  const original = chrome.proxy.settings.set;

  chrome.proxy.settings.set = ((details: unknown, cb?: () => void) => {
    const typedDetails = details as { value?: { pacScript?: { data?: string } } };
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("apply", () => {
    it("sets proxy when state is running and proxy enabled", () => {
      const spy = vi.spyOn(chrome.proxy.settings, "set");
      pm.apply(baseState());
      expect(spy).toHaveBeenCalled();
      const args = spy.mock.calls[0]![0] as { value: { mode: string } };
      expect(args.value.mode).toBe("pac_script");
    });

    it("clears proxy when backend is not running", () => {
      const spy = vi.spyOn(chrome.proxy.settings, "set");
      pm.apply(baseState());
      pm.apply(baseState({ backendState: "Stopped" }));
      const lastCall = spy.mock.calls.at(-1)![0] as { value: { mode: string } };
      expect(lastCall.value.mode).toBe("direct");
    });

    it("clears proxy when proxyEnabled is false", () => {
      const spy = vi.spyOn(chrome.proxy.settings, "set");
      pm.apply(baseState());
      pm.apply(baseState({ proxyEnabled: false }));
      const lastCall = spy.mock.calls.at(-1)![0] as { value: { mode: string } };
      expect(lastCall.value.mode).toBe("direct");
    });

    it("does nothing when proxy was never enabled and state is stopped", () => {
      const spy = vi.spyOn(chrome.proxy.settings, "set");
      pm.apply(baseState({ backendState: "Stopped" }));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("PAC script generation", () => {
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
        "SOCKS5 127.0.0.1:1055",
      );
      expect(route("http://100.100.100.100", "100.100.100.100")).toBe(
        "SOCKS5 127.0.0.1:1055",
      );
      expect(route("http://100.127.255.255", "100.127.255.255")).toBe(
        "SOCKS5 127.0.0.1:1055",
      );
    });

    it("routes MagicDNS names through proxy", () => {
      const route = evalPAC(pm, baseState());
      expect(route("http://my-server.example.ts.net", "my-server.example.ts.net")).toBe(
        "SOCKS5 127.0.0.1:1055",
      );
      expect(route("http://example.ts.net", "example.ts.net")).toBe(
        "SOCKS5 127.0.0.1:1055",
      );
      expect(route("http://notexample.ts.net", "notexample.ts.net")).toBe(
        "DIRECT",
      );
    });

    it("routes everything through proxy when exit node is active", () => {
      const route = evalPAC(
        pm,
        baseState({
          exitNode: {
            id: "exit1",
            hostname: "exit",
            location: null,
            online: true,
          },
        }),
      );
      expect(route("http://google.com", "google.com")).toBe(
        "SOCKS5 127.0.0.1:1055",
      );
      expect(route("http://192.168.1.1", "192.168.1.1")).toBe(
        "SOCKS5 127.0.0.1:1055",
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
        "SOCKS5 127.0.0.1:1055",
      );
      expect(route("http://172.20.5.1", "172.20.5.1")).toBe(
        "SOCKS5 127.0.0.1:1055",
      );
      expect(route("http://10.0.1.1", "10.0.1.1")).toBe("DIRECT");
      expect(route("http://172.32.0.1", "172.32.0.1")).toBe("DIRECT");
    });
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

  const fn = new Function("isInNet", "dnsDomainIs", `${pac}\nreturn FindProxyForURL;`);
  return fn(isInNet, dnsDomainIs) as (url: string, host: string) => string;
}
