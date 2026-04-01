import { initBackground } from "@tailchrome/shared/background/background";
import { ChromeProxyManager } from "./proxy-manager";
import { NATIVE_HOST_ID } from "../constants";

const { proxyManager } = initBackground(new ChromeProxyManager(), NATIVE_HOST_ID);

// Chrome-specific: clean up proxy when service worker suspends
chrome.runtime.onSuspend?.addListener(() => {
  proxyManager.clear();
});
