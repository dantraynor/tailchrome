import type { TailscaleState } from "@tailchrome/shared/shared/types";
import { TAILSCALE_SERVICE_IP } from "@tailchrome/shared/shared/constants";

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
    const shouldProxy =
      state.proxyEnabled &&
      state.proxyPort !== null &&
      state.backendState === "Running";

    if (!shouldProxy) {
      if (this.currentlyEnabled) {
        this.clear();
      }
      return;
    }

    // Update routing state
    this.proxyPort = state.proxyPort!;
    this.exitNodeActive = state.exitNode !== null;

    // Sanitize MagicDNS suffix
    const rawSuffix = (state.magicDNSSuffix ?? "").replace(/\.$/, "");
    this.magicDNSSuffix = /^[a-zA-Z0-9.\-]+$/.test(rawSuffix) ? rawSuffix : "";

    // Collect subnet routes
    this.subnetRanges = [];
    for (const peer of state.peers) {
      if (peer.isSubnetRouter && peer.subnets.length > 0) {
        for (const cidr of peer.subnets) {
          const parsed = this.parseCIDR(cidr);
          if (parsed) {
            this.subnetRanges.push(parsed);
          }
        }
      }
    }

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
    if (this.isInNet(host, 0x64400000, 0xffc00000)) return proxy;

    // Proxy MagicDNS names
    if (
      this.magicDNSSuffix &&
      (host === this.magicDNSSuffix || host.endsWith("." + this.magicDNSSuffix))
    ) {
      return proxy;
    }

    // Proxy subnet router ranges
    const hostNum = this.ipToNum(host);
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

  private isInNet(host: string, network: number, mask: number): boolean {
    const hostNum = this.ipToNum(host);
    if (hostNum === null) return false;
    return (hostNum & mask) === (network & mask);
  }

  private ipToNum(ip: string): number | null {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    let num = 0;
    for (const part of parts) {
      const octet = parseInt(part, 10);
      if (isNaN(octet) || octet < 0 || octet > 255) return null;
      num = (num << 8) | octet;
    }
    return num >>> 0;
  }

  private parseCIDR(cidr: string): { network: number; mask: number } | null {
    const parts = cidr.split("/");
    if (parts.length !== 2) return null;

    const network = parts[0]!;
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(network)) return null;
    const prefixLen = parseInt(parts[1]!, 10);
    if (isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) return null;

    const networkNum = this.ipToNum(network);
    if (networkNum === null) return null;

    const maskNum = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
    return { network: networkNum, mask: maskNum };
  }
}
