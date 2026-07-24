import type {
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

export interface FirefoxProxyInfo {
  type: "socks" | "direct";
  host?: string;
  port?: number;
  proxyDNS?: boolean;
}

type FirefoxProxyResult = FirefoxProxyInfo | Promise<FirefoxProxyInfo>;

declare const browser: {
  proxy: {
    onRequest: {
      addListener(
        listener: (details: { url: string }) => FirefoxProxyResult,
        filter: { urls: string[] },
      ): void;
      removeListener(
        listener: (details: { url: string }) => FirefoxProxyResult,
      ): void;
      hasListener(
        listener: (details: { url: string }) => FirefoxProxyResult,
      ): boolean;
    };
  };
  storage: {
    session: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(key: string): Promise<void>;
    };
  };
};

const STORAGE_KEY = "proxyConfig";

// Upper bound on how long held requests wait for the helper to come back.
// Reconnection retries forever (1s base backoff), so without a deadline a
// helper that is gone for good would hold every browser request until the
// user disables the extension. Past the deadline the gate fails open and
// requests go direct, matching the authoritative stopped state.
export const RECONNECT_GATE_TIMEOUT_MS = 10_000;

interface StoredProxyConfig {
  proxyPort: number;
  magicDNSSuffix: string;
  exitNodeActive: boolean;
  subnetRanges: Array<{ network: number; mask: number }>;
  splitMode: DomainSplitMode;
  splitDomains: string[];
}

export class FirefoxProxyManager {
  private proxyPort = 0;
  private magicDNSSuffix = "";
  private exitNodeActive = false;
  private subnetRanges: Array<{ network: number; mask: number }> = [];
  private splitMode: DomainSplitMode = "bypass";
  private splitDomains: string[] = [];
  private restorePromise: Promise<void> | null = null;
  private reconnectPromise: Promise<void> | null = null;
  private reconnectResolve: (() => void) | null = null;
  private restoreGeneration = 0;
  private restoreInFlight = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  readonly listener = (
    details: { url: string },
  ): FirefoxProxyInfo | Promise<FirefoxProxyInfo> => {
    if (this.proxyPort === 0 && this.restorePromise) {
      return this.restorePromise.then(() => {
        if (this.reconnectPromise) {
          return this.reconnectPromise.then(() =>
            this.resolveProxy(details.url),
          );
        }
        return this.resolveProxy(details.url);
      });
    }

    if (this.reconnectPromise) {
      return this.reconnectPromise.then(() => this.resolveProxy(details.url));
    }

    return this.resolveProxy(details.url);
  };

  apply(state: TailscaleState): void {
    if (!shouldProxyState(state)) {
      // An install error means the helper cannot come back without user
      // action, so it is authoritative even though the host is disconnected.
      const transient =
        !state.installError &&
        (!state.hostConnected ||
          state.backendState === "NoState" ||
          state.backendState === "Starting");

      if (transient) {
        // During startup/reconnect, preserve the last known configuration and
        // hold requests until Running, an authoritative stopped/login state,
        // or the gate deadline.
        if (
          this.restoreInFlight ||
          this.reconnectPromise ||
          this.proxyPort !== 0 ||
          this.magicDNSSuffix !== ""
        ) {
          this.proxyPort = 0;
          this.beginReconnectGate();
        }
        return;
      }

      this.restoreGeneration += 1;
      this.clear();
      void browser.storage.session.remove(STORAGE_KEY);
      return;
    }

    this.restoreGeneration += 1;
    this.proxyPort = state.proxyPort!;
    this.exitNodeActive = state.exitNode !== null;
    this.magicDNSSuffix = sanitizeMagicDNSSuffix(state.magicDNSSuffix);
    this.subnetRanges = collectSubnetCIDRs(state.peers)
      .map((cidr) => parseCIDR(cidr))
      .filter((r): r is { network: number; mask: number } => r !== null);
    this.splitMode = state.domainSplit.mode;
    this.splitDomains = sanitizeSplitDomains(state.domainSplit);
    this.releaseReconnectGate();

    if (!browser.proxy.onRequest.hasListener(this.listener)) {
      browser.proxy.onRequest.addListener(this.listener, {
        urls: ["<all_urls>"],
      });
    }

    void this.persistToStorage();
  }

  clear(): void {
    this.proxyPort = 0;
    this.magicDNSSuffix = "";
    this.exitNodeActive = false;
    this.subnetRanges = [];
    this.splitMode = "bypass";
    this.splitDomains = [];
    this.releaseReconnectGate();
  }

  restoreFromStorage(): Promise<boolean> {
    const generation = this.restoreGeneration;
    this.restoreInFlight = true;
    const restore = async (): Promise<boolean> => {
      const result = await browser.storage.session.get(STORAGE_KEY);
      if (generation !== this.restoreGeneration) {
        return false;
      }
      const config = result[STORAGE_KEY] as StoredProxyConfig | undefined;
      if (!config || !config.proxyPort) {
        return false;
      }

      this.magicDNSSuffix = config.magicDNSSuffix;
      this.exitNodeActive = config.exitNodeActive;
      this.subnetRanges = config.subnetRanges;
      this.splitMode = config.splitMode ?? "bypass";
      this.splitDomains = Array.isArray(config.splitDomains)
        ? config.splitDomains
        : [];
      this.beginReconnectGate();
      return true;
    };

    const promise = restore();
    // Request listeners only need to wait until the attempt is finished. Keep
    // restoration failures on the original promise so the startup logger owns
    // them instead of creating a second unhandled rejection here.
    this.restorePromise = promise.then(
      () => {},
      () => {},
    );
    void promise.then(
      () => {
        this.restoreInFlight = false;
      },
      () => {
        this.restoreInFlight = false;
      },
    );
    return promise;
  }

  private beginReconnectGate(): void {
    if (this.reconnectPromise) return;
    this.reconnectPromise = new Promise<void>((resolve) => {
      this.reconnectResolve = resolve;
    });
    // The gate and its held promises are in-memory, so they cannot outlive
    // the event page — a plain timer is enough, no alarm needed.
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.restoreGeneration += 1;
      this.clear();
      void browser.storage.session.remove(STORAGE_KEY);
    }, RECONNECT_GATE_TIMEOUT_MS);
  }

  private releaseReconnectGate(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reconnectResolve) {
      this.reconnectResolve();
      this.reconnectResolve = null;
    }
    this.reconnectPromise = null;
  }

  private async persistToStorage(): Promise<void> {
    const config: StoredProxyConfig = {
      proxyPort: this.proxyPort,
      magicDNSSuffix: this.magicDNSSuffix,
      exitNodeActive: this.exitNodeActive,
      subnetRanges: this.subnetRanges,
      splitMode: this.splitMode,
      splitDomains: this.splitDomains,
    };
    await browser.storage.session.set({ [STORAGE_KEY]: config });
  }

  private resolveProxy(url: string): FirefoxProxyInfo {
    const direct: FirefoxProxyInfo = { type: "direct" };

    if (this.proxyPort === 0) return direct;

    const proxy: FirefoxProxyInfo = {
      type: "socks",
      host: "127.0.0.1",
      port: this.proxyPort,
      proxyDNS: true,
    };

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
      (host === this.magicDNSSuffix ||
        host.endsWith(`.${this.magicDNSSuffix}`))
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
