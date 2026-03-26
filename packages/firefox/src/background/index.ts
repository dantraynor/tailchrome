import { initBackground } from "@tailchrome/shared/background/background";
import { FirefoxProxyManager } from "./proxy-manager";
import { NATIVE_HOST_ID } from "../constants";

initBackground(new FirefoxProxyManager(), NATIVE_HOST_ID);
// Firefox MV3 uses persistent background scripts — no onSuspend needed.
