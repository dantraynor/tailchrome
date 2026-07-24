import { initBackground } from "@tailchrome/shared/background/background";
import { ChromeAlarmTimerService } from "@tailchrome/shared/background/chrome-alarm-timer-service";
import { registerStartupWakeListener } from "@tailchrome/shared/background/startup-wake";
import { CHROME_NATIVE_HOST_ID } from "../constants";
import { ChromeProxyManager } from "./chrome-proxy-manager";

export function startChromeBackground(): void {
  // Wake the MV3 service worker at browser launch so initBackground below
  // runs auto-connect without waiting for the popup (#90).
  registerStartupWakeListener();

  const { proxyManager } = initBackground(
    new ChromeProxyManager(),
    CHROME_NATIVE_HOST_ID,
    {
      browserKind: "chrome",
      timerService: new ChromeAlarmTimerService(),
    },
  );

  chrome.runtime.onSuspend?.addListener(() => {
    proxyManager.clear();
  });
}
