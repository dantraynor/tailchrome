import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHROME_NATIVE_HOST_ID } from "../constants";

const mocks = vi.hoisted(() => ({
  initBackground: vi.fn(),
  ChromeProxyManager: vi.fn(),
}));

vi.mock("@tailchrome/shared/background/background", () => ({
  initBackground: mocks.initBackground,
}));

vi.mock("./chrome-proxy-manager", () => ({
  ChromeProxyManager: mocks.ChromeProxyManager,
}));

import { startChromeBackground } from "./chrome";

describe("startChromeBackground", () => {
  let onStartupAddListener: ReturnType<typeof vi.fn>;
  let onSuspendAddListener: ReturnType<typeof vi.fn>;
  let suspendListener: (() => void) | null;
  let proxyManagerInstance: { clear: ReturnType<typeof vi.fn> };

  const runtime = (
    globalThis.chrome as unknown as { runtime: Record<string, unknown> }
  ).runtime;

  beforeEach(() => {
    onStartupAddListener = vi.fn();
    suspendListener = null;
    onSuspendAddListener = vi.fn((fn: () => void) => {
      suspendListener = fn;
    });
    runtime["onStartup"] = { addListener: onStartupAddListener };
    runtime["onSuspend"] = { addListener: onSuspendAddListener };

    proxyManagerInstance = { clear: vi.fn() };
    mocks.ChromeProxyManager.mockReset();
    mocks.ChromeProxyManager.mockImplementation(function () {
      return proxyManagerInstance;
    });
    mocks.initBackground.mockReset();
    mocks.initBackground.mockImplementation((proxyManager: unknown) => ({
      proxyManager,
      reconnect: vi.fn(),
      sendKeepalive: vi.fn(),
    }));
  });

  afterEach(() => {
    delete runtime["onStartup"];
    delete runtime["onSuspend"];
  });

  it("registers a runtime.onStartup listener so the worker wakes at browser launch", () => {
    startChromeBackground();

    expect(onStartupAddListener).toHaveBeenCalledTimes(1);
    expect(onStartupAddListener).toHaveBeenCalledWith(expect.any(Function));
  });

  it("starts the shared background with the Chrome proxy manager", () => {
    startChromeBackground();

    expect(mocks.ChromeProxyManager).toHaveBeenCalledTimes(1);
    expect(mocks.initBackground).toHaveBeenCalledWith(
      proxyManagerInstance,
      CHROME_NATIVE_HOST_ID,
      { browserKind: "chrome" },
    );
  });

  it("clears proxy settings on suspend", () => {
    startChromeBackground();

    expect(onSuspendAddListener).toHaveBeenCalledTimes(1);
    suspendListener?.();
    expect(proxyManagerInstance.clear).toHaveBeenCalledTimes(1);
  });
});
