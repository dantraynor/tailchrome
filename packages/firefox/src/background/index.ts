import { initBackground } from "@tailchrome/shared/background/background";
import {
  FirefoxProxyManager,
  resolveProxy,
  type PersistedProxyConfig,
  type FirefoxProxyInfo,
} from "./proxy-manager";
import { AlarmsTimerService } from "./timer-service";
import { NATIVE_HOST_ID } from "../constants";

// Firefox provides `browser.*` APIs which are not in @types/chrome.
declare const browser: {
  proxy: {
    onRequest: {
      addListener(
        listener: (details: { url: string }) => FirefoxProxyInfo,
        filter: { urls: string[] },
      ): void;
    };
  };
  storage: {
    session: {
      get(key: string): Promise<Record<string, unknown>>;
    };
  };
};

// ---------------------------------------------------------------------------
// Top-level proxy listener — registered synchronously so it survives
// event page suspension. Reads from an in-memory config ref that is
// restored from session storage on wake and updated by FirefoxProxyManager.
// ---------------------------------------------------------------------------

let proxyConfig: PersistedProxyConfig | null = null;

browser.proxy.onRequest.addListener(
  (details: { url: string }): FirefoxProxyInfo => {
    if (!proxyConfig) return { type: "direct" };
    return resolveProxy(details.url, proxyConfig);
  },
  { urls: ["<all_urls>"] },
);

// Restore proxy config from session storage (async, but completes
// near-instantly since session storage is in-memory)
browser.storage.session.get("proxyConfig").then((result) => {
  if (result.proxyConfig) {
    proxyConfig = result.proxyConfig as PersistedProxyConfig;
  }
});

// ---------------------------------------------------------------------------
// Normal initialization with alarm-based timers
// ---------------------------------------------------------------------------

const proxyManager = new FirefoxProxyManager((config) => {
  proxyConfig = config;
});

initBackground(proxyManager, NATIVE_HOST_ID, {
  timerService: new AlarmsTimerService(),
});
