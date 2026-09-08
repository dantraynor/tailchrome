import { ProxySession } from "@tailchrome/shared/background/proxy-session";
import type {
  ProxySessionCredentials,
  DomainSplitConfig,
  DomainSplitMode,
  TailscaleState,
} from "@tailchrome/shared/types";
import {
  TAILSCALE_IPV6_PREFIX,
  TAILSCALE_SERVICE_IP,
} from "@tailchrome/shared/constants";
import {
  parseCIDR,
  ipToNum,
  sanitizeMagicDNSSuffix,
  sanitizeDomain,
  collectSubnetCIDRs,
  shouldProxyState,
  CGNAT_NETWORK,
  CGNAT_MASK,
} from "@tailchrome/shared/background/proxy-utils";

import type { RoutingHealth } from "@tailchrome/shared/types";
import {
  BLOCKED_PROXY_PORT,
  policyFromState,
} from "@tailchrome/shared/background/routing-protection";

export interface FirefoxProxyInfo {
  type: "socks" | "direct";
  host?: string;
  port?: number;
  proxyDNS?: boolean;
  username?: string;
  password?: string;
}

declare const browser: {
  proxy: {
    onRequest: {
      addListener(
        listener: (details: { url: string }) => unknown,
        filter: { urls: string[] },
      ): void;
      hasListener(listener: (details: { url: string }) => unknown): boolean;
    };
    onError: { addListener(listener: () => void): void };
  };
};

export class FirefoxProxyManager {
  private readonly session = new ProxySession();

  setProxySession(session: ProxySessionCredentials | null): void {
    this.session.set(session);
  }

  private proxyPort = BLOCKED_PROXY_PORT;
  private magicDNSSuffix = "";
  private exitNodeActive = true;
  private subnetRanges: Array<{ network: number; mask: number }> = [];
  private splitMode: DomainSplitMode = "bypass";
  private splitDomains: string[] = [];
  private mode: "active" | "blocked" | "direct" = "blocked";
  private failedKey = "";
  private policyKey = "";
  private healthListener: ((health: RoutingHealth) => void) | null = null;

  constructor() {
    browser.proxy.onError.addListener(() => {
      this.failedKey = this.policyKey;
      this.healthListener?.({
        status: "unavailable",
        message: "Firefox could not apply the routing settings.",
      });
    });
  }

  readonly listener = (details: {
    url: string;
  }): FirefoxProxyInfo | [FirefoxProxyInfo, null] =>
    this.resolveProxy(details.url);

  setRoutingHealthListener(listener: (health: RoutingHealth) => void): void {
    this.healthListener = listener;
  }

  apply(state: TailscaleState): void {
    const requestedPolicy = policyFromState(state);
    const policy = requestedPolicy.mode === "active" && !this.session.credentialsFor(requestedPolicy.proxyPort ?? 0)
      ? { ...requestedPolicy, mode: "blocked" as const, proxyPort: null }
      : requestedPolicy;
    const nextKey = JSON.stringify(policy);
    if (nextKey !== this.policyKey) this.failedKey = "";
    this.policyKey = nextKey;
    if (this.failedKey === this.policyKey) return;
    this.mode = policy.mode;
    this.proxyPort = policy.proxyPort ?? BLOCKED_PROXY_PORT;
    this.exitNodeActive =
      policy.blockAll === true || policy.selectedExitNodeID !== null;
    this.magicDNSSuffix = sanitizeMagicDNSSuffix(policy.magicDNSSuffix);
    this.subnetRanges = policy.subnetCIDRs
      .map((cidr) => parseCIDR(cidr))
      .filter((r): r is { network: number; mask: number } => r !== null);
    this.splitMode = policy.domainSplit.mode;
    this.splitDomains = sanitizeSplitDomains(policy.domainSplit);
    try {
      if (!browser.proxy.onRequest.hasListener(this.listener)) {
        browser.proxy.onRequest.addListener(this.listener, {
          urls: ["<all_urls>"],
        });
      }
      this.healthListener?.(
        this.mode === "blocked"
          ? {
              status: "blocked",
              message: this.exitNodeActive
                ? "Exit node unavailable — protected browsing is blocked."
                : "Connection unavailable — tailnet browsing is blocked.",
            }
          : {
              status: this.mode === "active" ? "active" : "inactive",
              message: "",
            },
      );
    } catch {
      this.healthListener?.({
        status: "unavailable",
        message: "Firefox could not apply the routing settings.",
      });
    }
  }

  clear(): void {
    this.mode = "direct";
    this.healthListener?.({ status: "inactive", message: "" });
  }

  private resolveProxy(
    url: string,
  ): FirefoxProxyInfo | [FirefoxProxyInfo, null] {
    const direct: FirefoxProxyInfo = { type: "direct" };

    if (this.mode === "direct") return direct;

    const proxy: [FirefoxProxyInfo, null] = [
      {
        type: "socks",
        host: "127.0.0.1",
        port: this.mode === "blocked" || !this.session.credentialsFor(this.proxyPort) ? BLOCKED_PROXY_PORT : this.proxyPort,
        proxyDNS: true,
        ...(this.mode === "active" ? this.session.credentialsFor(this.proxyPort) : undefined),
      },
      null,
    ];

    let host: string;
    try {
      host = new URL(url).hostname;
      if (host.startsWith("[") && host.endsWith("]")) {
        host = host.slice(1, -1);
      }
    } catch {
      return direct;
    }

    if (host === TAILSCALE_SERVICE_IP) return proxy;
    if (host.toLowerCase().startsWith(TAILSCALE_IPV6_PREFIX)) return proxy;

    const hostNum = ipToNum(host);
    if (hostNum !== null && (hostNum & CGNAT_MASK) === CGNAT_NETWORK) {
      return proxy;
    }

    if (
      this.magicDNSSuffix &&
      (host === this.magicDNSSuffix || host.endsWith(`.${this.magicDNSSuffix}`))
    ) {
      return proxy;
    }

    if (hostNum !== null) {
      for (const range of this.subnetRanges) {
        if ((hostNum & range.mask) === (range.network & range.mask)) {
          return proxy;
        }
      }
    }

    if (this.exitNodeActive) {
      if (this.splitMode === "only") {
        // Only mode: empty list means nothing leaves through the exit node.
        return this.matchSplitDomain(host) ? proxy : direct;
      }
      if (this.splitDomains.length > 0 && this.matchSplitDomain(host)) {
        return direct;
      }
      return proxy;
    }

    return direct;
  }

  private matchSplitDomain(host: string): boolean {
    for (const d of this.splitDomains) {
      if (host === d || host.endsWith(`.${d}`)) return true;
    }
    return false;
  }
}

function sanitizeSplitDomains(config: DomainSplitConfig): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of config.domains) {
    const cleaned = sanitizeDomain(raw);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}
