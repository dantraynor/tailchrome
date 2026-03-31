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

/**
 * Firefox proxy manager using the browser.proxy.onRequest API.
 *
 * Unlike Chrome's PAC script approach, Firefox uses a listener-based model
 * where each request triggers a callback that returns proxy info.
 */

interface FirefoxProxyInfo {
  type: "socks" | "direct";
  host?: string;
  port?: number;
  proxyDNS?: boolean;
}

// Firefox provides `browser.proxy` and `browser.storage.session` which are not
// in @types/chrome. We declare the minimal interface we need.
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

const STORAGE_KEY = "proxyConfig";

interface StoredProxyConfig {
  proxyPort: number;
  magicDNSSuffix: string;
  exitNodeActive: boolean;
  subnetRanges: Array<{ network: number; mask: number }>;
}

export class FirefoxProxyManager {
  private proxyPort: number = 0;
  private magicDNSSuffix: string = "";
  private exitNodeActive: boolean = false;
  private subnetRanges: Array<{ network: number; mask: number }> = [];

  /** The proxy request listener. Exposed so the entry point can register it synchronously. */
  readonly listener = (details: { url: string }): FirefoxProxyInfo => {
    return this.resolveProxy(details.url);
  };

  apply(state: TailscaleState): void {
    if (!shouldProxyState(state)) {
      this.clear();
      // Only wipe stored config when we have an authoritative signal that
      // proxying should be off — the host is connected but the backend is not
      // running. During event-page suspension Firefox closes the native port,
      // which triggers a disconnect → apply(proxyEnabled:false). We must NOT
      // clear storage in that case because restoreFromStorage() needs it on
      // the next wake.
      if (state.hostConnected && state.backendState !== "Running") {
        browser.storage.session.remove(STORAGE_KEY);
      }
      return;
    }

    // Update routing state
    this.proxyPort = state.proxyPort!;
    this.exitNodeActive = state.exitNode !== null;

    // Sanitize MagicDNS suffix
    this.magicDNSSuffix = sanitizeMagicDNSSuffix(state.magicDNSSuffix);

    // Collect subnet routes
    this.subnetRanges = collectSubnetCIDRs(state.peers)
      .map((cidr) => parseCIDR(cidr))
      .filter((r): r is { network: number; mask: number } => r !== null);

    // Register the listener if not already active. Check the actual browser
    // state — the entry point may have already registered the listener
    // synchronously at top level before apply() runs.
    if (!browser.proxy.onRequest.hasListener(this.listener)) {
      browser.proxy.onRequest.addListener(
        this.listener,
        { urls: ["<all_urls>"] },
      );
    }

    // Persist config so it survives event page suspension
    this.persistToStorage();
  }

  clear(): void {
    // Reset routing state so the listener returns "direct" for all requests.
    // We intentionally do NOT remove the proxy.onRequest listener here — on
    // Firefox the entry point registers it synchronously at top level so it
    // persists across event-page suspend/wake cycles. Removing it during the
    // disconnect path (which fires when the page idles) would defeat that.
    // With proxyPort reset to 0, resolveProxy() returns "direct" for
    // everything, which is the correct behaviour when we have no valid config.
    this.proxyPort = 0;
    this.magicDNSSuffix = "";
    this.exitNodeActive = false;
    this.subnetRanges = [];
  }

  /**
   * Restore proxy config from session storage after event page wake.
   * Returns true if config was found and restored.
   */
  async restoreFromStorage(): Promise<boolean> {
    const result = await browser.storage.session.get(STORAGE_KEY);
    const config = result[STORAGE_KEY] as StoredProxyConfig | undefined;
    if (!config || !config.proxyPort) {
      return false;
    }
    this.proxyPort = config.proxyPort;
    this.magicDNSSuffix = config.magicDNSSuffix;
    this.exitNodeActive = config.exitNodeActive;
    this.subnetRanges = config.subnetRanges;
    return true;
  }

  private persistToStorage(): void {
    const config: StoredProxyConfig = {
      proxyPort: this.proxyPort,
      magicDNSSuffix: this.magicDNSSuffix,
      exitNodeActive: this.exitNodeActive,
      subnetRanges: this.subnetRanges,
    };
    browser.storage.session.set({ [STORAGE_KEY]: config });
  }

  private resolveProxy(url: string): FirefoxProxyInfo {
    const direct: FirefoxProxyInfo = { type: "direct" };

    // No valid proxy config loaded — return direct for everything. This
    // covers the window between synchronous listener registration and async
    // restoreFromStorage(), and the state after clear().
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
      this.magicDNSSuffix &&
      (host === this.magicDNSSuffix || host.endsWith("." + this.magicDNSSuffix))
    ) {
      return proxy;
    }

    // Proxy subnet router ranges
    if (hostNum !== null) {
      for (const range of this.subnetRanges) {
        if ((hostNum & range.mask) === (range.network & range.mask)) {
          return proxy;
        }
      }
    }

    // If exit node is active, proxy ALL traffic
    if (this.exitNodeActive) return proxy;

    return direct;
  }
}
