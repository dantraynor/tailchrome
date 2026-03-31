import type { TailscaleState } from "@tailchrome/shared/types";
import { TAILSCALE_SERVICE_IP } from "@tailchrome/shared/constants";
import {
  parseCIDR,
  ipToNum,
  sanitizeMagicDNSSuffix,
  collectSubnetCIDRs,
  shouldProxyState,
  CGNAT_NETWORK,
  CGNAT_MASK,
} from "@tailchrome/shared/background/proxy-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FirefoxProxyInfo {
  type: "socks" | "direct";
  host?: string;
  port?: number;
  proxyDNS?: boolean;
}

export interface PersistedProxyConfig {
  proxyPort: number;
  magicDNSSuffix: string;
  exitNodeActive: boolean;
  subnetRanges: Array<{ network: number; mask: number }>;
}

// Firefox provides `browser.*` APIs which are not in @types/chrome.
// We declare the minimal interface we need.
declare const browser: {
  proxy: {
    onRequest: {
      addListener(
        listener: (details: { url: string }) => FirefoxProxyInfo,
        filter: { urls: string[] },
      ): void;
      removeListener(
        listener: (details: { url: string }) => FirefoxProxyInfo,
      ): void;
      hasListener(
        listener: (details: { url: string }) => FirefoxProxyInfo,
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

// ---------------------------------------------------------------------------
// Pure proxy resolution function
// ---------------------------------------------------------------------------

/**
 * Determine whether a URL should be proxied through Tailscale.
 * This is a pure function so it can be used both by the top-level
 * browser.proxy.onRequest listener and by FirefoxProxyManager.
 */
export function resolveProxy(
  url: string,
  config: PersistedProxyConfig,
): FirefoxProxyInfo {
  const direct: FirefoxProxyInfo = { type: "direct" };
  const proxy: FirefoxProxyInfo = {
    type: "socks",
    host: "127.0.0.1",
    port: config.proxyPort,
    proxyDNS: true,
  };

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return direct;
  }

  // Always proxy Tailscale service IP
  if (host === TAILSCALE_SERVICE_IP) return proxy;

  // Proxy all Tailscale CGNAT IPs (100.64.0.0/10)
  const hostNum = ipToNum(host);
  if (hostNum !== null && (hostNum & CGNAT_MASK) === CGNAT_NETWORK) {
    return proxy;
  }

  // Proxy MagicDNS names
  if (
    config.magicDNSSuffix &&
    (host === config.magicDNSSuffix ||
      host.endsWith("." + config.magicDNSSuffix))
  ) {
    return proxy;
  }

  // Proxy subnet router ranges
  if (hostNum !== null) {
    for (const range of config.subnetRanges) {
      if ((hostNum & range.mask) === (range.network & range.mask)) {
        return proxy;
      }
    }
  }

  // If exit node is active, proxy ALL traffic
  if (config.exitNodeActive) return proxy;

  return direct;
}

// ---------------------------------------------------------------------------
// Firefox proxy manager
// ---------------------------------------------------------------------------

/**
 * Firefox proxy manager that persists proxy config to browser.storage.session
 * and updates an in-memory config ref for the top-level proxy.onRequest listener.
 *
 * The listener itself is registered at the top level of the background script
 * (index.ts) so it survives event page suspension. This class only manages
 * the config state that the listener reads.
 */
export class FirefoxProxyManager {
  constructor(
    private setConfig: (config: PersistedProxyConfig | null) => void,
  ) {}

  apply(state: TailscaleState): void {
    if (!shouldProxyState(state)) {
      // Always clear — after an event page wake the in-memory `enabled` flag
      // resets to false, but restored session storage config may still be active.
      this.clear();
      return;
    }

    const config: PersistedProxyConfig = {
      proxyPort: state.proxyPort!,
      exitNodeActive: state.exitNode !== null,
      magicDNSSuffix: sanitizeMagicDNSSuffix(state.magicDNSSuffix),
      subnetRanges: collectSubnetCIDRs(state.peers)
        .map((cidr) => parseCIDR(cidr))
        .filter((r): r is { network: number; mask: number } => r !== null),
    };

    // Update in-memory config for the top-level listener
    this.setConfig(config);

    // Persist to session storage so config survives event page suspension
    browser.storage.session.set({ proxyConfig: config });
  }

  clear(): void {
    this.setConfig(null);
    browser.storage.session.remove("proxyConfig");
  }
}
