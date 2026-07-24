import {
  initBackground,
  type BackgroundHandle,
} from "@tailchrome/shared/background/background";
import { registerStartupWakeListener } from "@tailchrome/shared/background/startup-wake";
import { registerSidebarOpener } from "@tailchrome/shared/background/ui-surface";
import { KEEPALIVE_INTERVAL_MS } from "@tailchrome/shared/constants";
import { FIREFOX_NATIVE_HOST_ID } from "../constants";
import { FirefoxProxyManager } from "./firefox-proxy-manager";

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

const KEEPALIVE_PERIOD_MINUTES = KEEPALIVE_INTERVAL_MS / 60_000;

export function startFirefoxBackground(): void {
  const proxyManager = new FirefoxProxyManager();
  let backgroundHandle: BackgroundHandle | null = null;
  let sawBrowserStartup = false;
  let installedReason: chrome.runtime.InstalledDetails["reason"] | undefined;

  // Register the sidebar opener synchronously at top-level so a toolbar
  // click that wakes a dormant service worker is delivered to the listener.
  // Anything registered later (after async storage restore resolves) can
  // miss the wake-up event.
  registerSidebarOpener();

  // Wake the background at browser launch so the restore chain below runs
  // auto-connect without waiting for the popup (#90).
  registerStartupWakeListener(() => {
    sawBrowserStartup = true;
  });

  // initBackground is intentionally delayed until proxy restoration finishes,
  // but runtime events that wake an MV3 worker are not replayed for listeners
  // registered after that await. Capture updates now and forward the signal.
  chrome.runtime.onInstalled?.addListener((details) => {
    installedReason = details.reason;
  });

  browser.proxy.onRequest.addListener(proxyManager.listener, {
    urls: ["<all_urls>"],
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepalive" && backgroundHandle) {
      backgroundHandle.sendKeepalive();
    }
  });

  void proxyManager
    .restoreFromStorage()
    .then(() => {
      backgroundHandle = initBackground(proxyManager, FIREFOX_NATIVE_HOST_ID, {
        skipKeepalive: true,
        browserKind: "firefox",
        initialRuntimeLifecycle: {
          browserStartup: sawBrowserStartup,
          installedReason,
        },
      });

      browser.alarms.create("keepalive", {
        periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
      });
    })
    .catch((err) => {
      console.error("[Firefox] Background start failed:", err);
    });
}
