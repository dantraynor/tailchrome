import { initBackground, type BackgroundHandle } from "@tailchrome/shared/background/background";
import { FirefoxProxyManager } from "./proxy-manager";
import { NATIVE_HOST_ID } from "../constants";

// Minimal type declarations for Firefox-specific APIs not in @types/chrome.
declare const browser: {
  proxy: {
    onRequest: {
      addListener(
        listener: (details: { url: string }) => unknown,
        filter: { urls: string[] },
      ): void;
    };
  };
  alarms: {
    create(name: string, info: { periodInMinutes: number }): void;
    onAlarm: {
      addListener(listener: (alarm: { name: string }) => void): void;
    };
  };
};

// ---------------------------------------------------------------------------
// All event listeners must be registered synchronously at the top level so
// Firefox persists them across event-page suspension/wake cycles.
// ---------------------------------------------------------------------------

const proxyManager = new FirefoxProxyManager();

// Register the proxy listener synchronously. Firefox re-runs top-level code
// on event page wake and re-registers the listener, so the proxy keeps
// working even after suspension.
browser.proxy.onRequest.addListener(proxyManager.listener, {
  urls: ["<all_urls>"],
});

// The background handle is set once start() completes. The alarm listener
// below checks this before sending keepalives.
let backgroundHandle: BackgroundHandle | null = null;

// Register the alarm listener synchronously at top level so Firefox can use
// it to wake the event page when the keepalive alarm fires.
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive" && backgroundHandle) {
    backgroundHandle.sendKeepalive();
  }
});

// ---------------------------------------------------------------------------
// Restore persisted proxy config, then initialise the background.
// ---------------------------------------------------------------------------

// KEEPALIVE_INTERVAL_MS is 25 000 ms ≈ 0.42 minutes
const KEEPALIVE_PERIOD_MINUTES = 25_000 / 60_000;

async function start(): Promise<void> {
  // Hydrate in-memory proxy state from session storage so the synchronous
  // listener can route requests correctly before the native host reconnects.
  await proxyManager.restoreFromStorage();

  backgroundHandle = initBackground(proxyManager, NATIVE_HOST_ID, {
    skipKeepalive: true,
  });

  // Create the alarm after init — the listener is already registered above.
  browser.alarms.create("keepalive", {
    periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
  });
}

start().catch((err) => {
  console.error("[Firefox] Background start failed:", err);
});
