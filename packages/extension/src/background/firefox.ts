import {
  initBackground,
  type BackgroundHandle,
} from "@tailchrome/shared/background/background";
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

const KEEPALIVE_PERIOD_MINUTES = 25_000 / 60_000;

export function startFirefoxBackground(): void {
  const proxyManager = new FirefoxProxyManager();
  let backgroundHandle: BackgroundHandle | null = null;

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
      });

      browser.alarms.create("keepalive", {
        periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
      });
    })
    .catch((err) => {
      console.error("[Firefox] Background start failed:", err);
    });
}
