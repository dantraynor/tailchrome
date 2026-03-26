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

// Firefox provides `browser.proxy` which is not in @types/chrome.
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
};

export class FirefoxProxyManager {
  private currentlyEnabled = false;
  private proxyPort: number = 0;
  private magicDNSSuffix: string = "";
  private exitNodeActive: boolean = false;
  private subnetRanges: Array<{ network: number; mask: number }> = [];

  private listener = (details: { url: string }): FirefoxProxyInfo => {
    return this.resolveProxy(details.url);
  };

  apply(state: TailscaleState): void {
    if (!shouldProxyState(state)) {
      if (this.currentlyEnabled) {
        this.clear();
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

    // Register the listener if not already active
    if (!this.currentlyEnabled) {
      browser.proxy.onRequest.addListener(
        this.listener,
        { urls: ["<all_urls>"] },
      );
      this.currentlyEnabled = true;
    }
  }

  clear(): void {
    if (this.currentlyEnabled) {
      browser.proxy.onRequest.removeListener(this.listener);
      this.currentlyEnabled = false;
    }
  }

  private resolveProxy(url: string): FirefoxProxyInfo {
    const direct: FirefoxProxyInfo = { type: "direct" };
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
