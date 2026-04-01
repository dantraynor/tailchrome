import { initBackground } from "@tailchrome/shared/background/background";
import { CHROME_NATIVE_HOST_ID } from "../constants";
import { ChromeProxyManager } from "./chrome-proxy-manager";

export function startChromeBackground(): void {
  const { proxyManager } = initBackground(
    new ChromeProxyManager(),
    CHROME_NATIVE_HOST_ID,
  );

  chrome.runtime.onSuspend?.addListener(() => {
    proxyManager.clear();
  });
}
