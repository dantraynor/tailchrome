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

interface StoredProxyConfig {
  proxyPort: number;
  magicDNSSuffix: string;
  exitNodeActive: boolean;
  subnetRanges: Array<{ network: number; mask: number }>;
}

export class FirefoxProxyManager {
  private proxyPort = 0;
  private magicDNSSuffix = "";
  private exitNodeActive = false;
  private subnetRanges: Array<{ network: number; mask: number }> = [];
  private restorePromise: Promise<void> | null = null;
  private reconnectPromise: Promise<void> | null = null;
  private reconnectResolve: (() => void) | null = null;

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
      this.clear();
      if (state.hostConnected && state.backendState !== "Running") {
        void browser.storage.session.remove(STORAGE_KEY);
      }
      return;
    }

    this.proxyPort = state.proxyPort!;
    this.exitNodeActive = state.exitNode !== null;
    this.magicDNSSuffix = sanitizeMagicDNSSuffix(state.magicDNSSuffix);
    this.subnetRanges = collectSubnetCIDRs(state.peers)
      .map((cidr) => parseCIDR(cidr))
      .filter((r): r is { network: number; mask: number } => r !== null);
    this.restorePromise = null;

    if (this.reconnectResolve) {
      this.reconnectResolve();
      this.reconnectResolve = null;
    }
    this.reconnectPromise = null;

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

    if (this.reconnectResolve) {
      this.reconnectResolve();
      this.reconnectResolve = null;
    }
    this.reconnectPromise = null;
  }

  restoreFromStorage(): Promise<boolean> {
    const restore = async (): Promise<boolean> => {
      const result = await browser.storage.session.get(STORAGE_KEY);
      const config = result[STORAGE_KEY] as StoredProxyConfig | undefined;
      if (!config || !config.proxyPort) {
        return false;
      }

      this.magicDNSSuffix = config.magicDNSSuffix;
      this.exitNodeActive = config.exitNodeActive;
      this.subnetRanges = config.subnetRanges;
      this.reconnectPromise = new Promise<void>((resolve) => {
        this.reconnectResolve = resolve;
      });
      return true;
    };

    const promise = restore();
    this.restorePromise = promise.then(() => {});
    return promise;
  }

  private async persistToStorage(): Promise<void> {
    const config: StoredProxyConfig = {
      proxyPort: this.proxyPort,
      magicDNSSuffix: this.magicDNSSuffix,
      exitNodeActive: this.exitNodeActive,
      subnetRanges: this.subnetRanges,
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
    } catch {
      return direct;
    }

    if (host === TAILSCALE_SERVICE_IP) return proxy;

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

    if (this.exitNodeActive) return proxy;

    return direct;
  }
}
