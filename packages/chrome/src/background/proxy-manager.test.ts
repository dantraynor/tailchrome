import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChromeProxyManager } from "./proxy-manager";
import type { TailscaleState } from "@tailchrome/shared/types";
import { baseState, makePeer } from "@tailchrome/shared/__test__/fixtures";

/** Capture the PAC script string passed to chrome.proxy.settings.set */
function capturePAC(pm: ChromeProxyManager, state: TailscaleState): string | null {
  let captured: string | null = null;
  const original = chrome.proxy.settings.set;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chrome.proxy.settings.set = ((details: unknown, cb?: () => void) => {
    const d = details as { value?: { pacScript?: { data?: string } } };
    captured = d.value?.pacScript?.data ?? null;
    cb?.();
    return Promise.resolve();
  }) as any;
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
      // First enable so there's something to clear
      pm.apply(baseState());
      // Then stop — should switch to direct
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
      // The final line before the closing brace should return proxy unconditionally
      expect(pac).toMatch(/return proxy;\s*\n\s*}$/);
    });

    it("includes subnet routes from peers", () => {
      const state = baseState({
        peers: [
          makePeer({ subnets: ["10.0.0.0/24", "192.168.1.0/16"] }),
        ],
      });
      const pac = capturePAC(pm, state)!;
      expect(pac).toContain('isInNet(host, "10.0.0.0", "255.255.255.0")');
      expect(pac).toContain('isInNet(host, "192.168.1.0", "255.255.0.0")');
    });

    it("skips non-subnet-router peers", () => {
      const state = baseState({
        peers: [
          makePeer({ isSubnetRouter: false }),
        ],
      });
      const pac = capturePAC(pm, state)!;
      // The CGNAT check uses isInNet too, so check the subnet section specifically
      const subnetSection = pac.split("// Proxy subnet router ranges")[1]!;
      expect(subnetSection).toContain("// No subnet routes");
      expect(subnetSection).not.toContain("isInNet(host,");
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
      const state = baseState({ magicDNSSuffix: null });
      // magicDNSSuffix defaults to "" when null via the ?? "" in apply()
      const pac = capturePAC(pm, state)!;
      expect(pac).toContain("// No MagicDNS suffix configured");
    });
  });

  describe("PAC script routing decisions", () => {
    // Evaluate the PAC script as real JS and test actual routing behavior

    it("routes Tailscale IPs through proxy, regular sites DIRECT", () => {
      const route = evalPAC(pm, baseState());
      expect(route("http://google.com", "google.com")).toBe("DIRECT");
      expect(route("http://100.64.0.5", "100.64.0.5")).toBe("SOCKS5 127.0.0.1:1055");
      expect(route("http://100.100.100.100", "100.100.100.100")).toBe("SOCKS5 127.0.0.1:1055");
      expect(route("http://100.127.255.255", "100.127.255.255")).toBe("SOCKS5 127.0.0.1:1055");
    });

    it("routes MagicDNS names through proxy", () => {
      const route = evalPAC(pm, baseState());
      expect(route("http://my-server.example.ts.net", "my-server.example.ts.net")).toBe("SOCKS5 127.0.0.1:1055");
      expect(route("http://example.ts.net", "example.ts.net")).toBe("SOCKS5 127.0.0.1:1055");
      // But not partial matches
      expect(route("http://notexample.ts.net", "notexample.ts.net")).toBe("DIRECT");
    });

    it("routes everything through proxy when exit node is active", () => {
      const state = baseState({
        exitNode: { id: "exit1", hostname: "exit", location: null, online: true },
      });
      const route = evalPAC(pm, state);
      expect(route("http://google.com", "google.com")).toBe("SOCKS5 127.0.0.1:1055");
      expect(route("http://192.168.1.1", "192.168.1.1")).toBe("SOCKS5 127.0.0.1:1055");
      expect(route("https://example.com/path", "example.com")).toBe("SOCKS5 127.0.0.1:1055");
    });

    it("routes everything through proxy via Mullvad exit node", () => {
      const state = baseState({
        exitNode: {
          id: "mullvad-se1",
          hostname: "se-sto-wg-001",
          location: { city: "Stockholm", country: "Sweden", countryCode: "SE" },
          online: true,
        },
      });
      const route = evalPAC(pm, state);
      // All traffic should be proxied — same behavior as any exit node
      expect(route("http://google.com", "google.com")).toBe("SOCKS5 127.0.0.1:1055");
      expect(route("http://192.168.1.1", "192.168.1.1")).toBe("SOCKS5 127.0.0.1:1055");
      expect(route("http://8.8.8.8", "8.8.8.8")).toBe("SOCKS5 127.0.0.1:1055");
      // Tailscale IPs still routed through proxy
      expect(route("http://100.64.0.5", "100.64.0.5")).toBe("SOCKS5 127.0.0.1:1055");
    });

    it("routes subnet ranges through proxy", () => {
      const state = baseState({
        peers: [makePeer({ subnets: ["10.0.0.0/24", "172.16.0.0/12"] })],
      });
      const route = evalPAC(pm, state);
      // Inside subnets
      expect(route("http://10.0.0.50", "10.0.0.50")).toBe("SOCKS5 127.0.0.1:1055");
      expect(route("http://172.20.5.1", "172.20.5.1")).toBe("SOCKS5 127.0.0.1:1055");
      // Outside subnets
      expect(route("http://10.0.1.1", "10.0.1.1")).toBe("DIRECT");
      expect(route("http://172.32.0.1", "172.32.0.1")).toBe("DIRECT");
    });

    it("does not proxy non-Tailscale IPs outside CGNAT range", () => {
      const route = evalPAC(pm, baseState());
      expect(route("http://192.168.1.1", "192.168.1.1")).toBe("DIRECT");
      expect(route("http://10.0.0.1", "10.0.0.1")).toBe("DIRECT");
      expect(route("http://8.8.8.8", "8.8.8.8")).toBe("DIRECT");
    });

    it("uses the configured proxy port", () => {
      const state = baseState({ proxyPort: 9999 });
      const route = evalPAC(pm, state);
      expect(route("http://100.64.0.1", "100.64.0.1")).toBe("SOCKS5 127.0.0.1:9999");
    });
  });

});

/**
 * Evaluate the generated PAC script as real JavaScript.
 * Provides implementations of the PAC built-in functions (isInNet, dnsDomainIs)
 * so we can test actual routing decisions, not just string contents.
 */
function evalPAC(
  pm: ChromeProxyManager,
  state: TailscaleState
): (url: string, host: string) => string {
  const pac = capturePAC(pm, state);
  if (!pac) throw new Error("No PAC script generated");

  // PAC built-in: isInNet(host, network, mask)
  const isInNet = (host: string, network: string, mask: string): boolean => {
    const toNum = (ip: string) =>
      ip.split(".").reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
    const h = toNum(host);
    const n = toNum(network);
    const m = toNum(mask);
    return (h & m) === (n & m);
  };

  // PAC built-in: dnsDomainIs(host, suffix)
  const dnsDomainIs = (host: string, suffix: string): boolean => {
    return host === suffix.slice(1) || host.endsWith(suffix);
  };

  // Evaluate the PAC script in a closure with the built-in functions
  const fn = new Function("isInNet", "dnsDomainIs", pac + "\nreturn FindProxyForURL;");
  const FindProxyForURL = fn(isInNet, dnsDomainIs) as (url: string, host: string) => string;
  return FindProxyForURL;
}

