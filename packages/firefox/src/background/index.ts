import { initBackground } from "@tailchrome/shared/background/background";
import { FirefoxProxyManager } from "./proxy-manager";
import { NATIVE_HOST_ID } from "../constants";

initBackground(new FirefoxProxyManager(), NATIVE_HOST_ID);
// TODO: Firefox MV3 event pages are non-persistent. The keepalive pings keep
// the page alive while connected, but if it idles, in-memory proxy state and
// timers are lost. A future improvement should persist proxy config to
// browser.storage.session and register the proxy.onRequest listener
// synchronously at startup.
