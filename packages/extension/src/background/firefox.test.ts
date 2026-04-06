import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIREFOX_NATIVE_HOST_ID } from "../constants";

const mocks = vi.hoisted(() => ({
  initBackground: vi.fn(),
  restoreFromStorage: vi.fn(),
  sendKeepalive: vi.fn(),
  proxyManagerInstance: {
    listener: vi.fn(),
    restoreFromStorage: vi.fn(),
  },
  FirefoxProxyManager: vi.fn(),
}));

vi.mock("@tailchrome/shared/background/background", () => ({
  initBackground: mocks.initBackground,
}));

vi.mock("./firefox-proxy-manager", () => ({
  FirefoxProxyManager: mocks.FirefoxProxyManager,
}));

import { startFirefoxBackground } from "./firefox";

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

describe("startFirefoxBackground", () => {
  let proxyAddListener: ReturnType<typeof vi.fn>;
  let alarmAddListener: ReturnType<typeof vi.fn>;
  let alarmsCreate: ReturnType<typeof vi.fn>;
  let alarmListener: ((alarm: { name: string }) => void) | null;
  let originalBrowser: unknown;

  const getBrowser = (): unknown =>
    (globalThis as typeof globalThis & { browser?: unknown }).browser;

  const setBrowser = (value: unknown) => {
    Object.defineProperty(globalThis, "browser", {
      value,
      writable: true,
      configurable: true,
    });
  };

  beforeEach(() => {
    proxyAddListener = vi.fn();
    alarmListener = null;
    alarmAddListener = vi.fn((listener: (alarm: { name: string }) => void) => {
      alarmListener = listener;
    });
    alarmsCreate = vi.fn();

    originalBrowser = getBrowser();
    setBrowser({
      proxy: {
        onRequest: {
          addListener: proxyAddListener,
        },
      },
      alarms: {
        create: alarmsCreate,
        onAlarm: {
          addListener: alarmAddListener,
        },
      },
    });

    mocks.sendKeepalive.mockReset();
    mocks.initBackground.mockReset();
    mocks.restoreFromStorage.mockReset();
    mocks.proxyManagerInstance = {
      listener: vi.fn(),
      restoreFromStorage: mocks.restoreFromStorage,
    };
    mocks.FirefoxProxyManager.mockReset();
    mocks.FirefoxProxyManager.mockImplementation(() => mocks.proxyManagerInstance);
    mocks.initBackground.mockReturnValue({
      proxyManager: mocks.proxyManagerInstance,
      reconnect: vi.fn(),
      sendKeepalive: mocks.sendKeepalive,
    });
  });

  afterEach(() => {
    setBrowser(originalBrowser);
  });

  it("registers the Firefox proxy and alarm listeners immediately", () => {
    mocks.restoreFromStorage.mockReturnValue(new Promise<boolean>(() => {}));

    startFirefoxBackground();

    expect(mocks.FirefoxProxyManager).toHaveBeenCalledTimes(1);
    expect(proxyAddListener).toHaveBeenCalledWith(
      mocks.proxyManagerInstance.listener,
      { urls: ["<all_urls>"] },
    );
    expect(alarmAddListener).toHaveBeenCalledTimes(1);
  });

  it("waits for restore before starting the shared background and keepalive alarm", async () => {
    let resolveRestore!: (value: boolean) => void;
    mocks.restoreFromStorage.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveRestore = resolve;
      }),
    );

    startFirefoxBackground();

    expect(mocks.initBackground).not.toHaveBeenCalled();
    expect(alarmsCreate).not.toHaveBeenCalled();

    resolveRestore(true);
    await flushMicrotasks();

    expect(mocks.initBackground).toHaveBeenCalledWith(
      mocks.proxyManagerInstance,
      FIREFOX_NATIVE_HOST_ID,
      { skipKeepalive: true },
    );
    expect(alarmsCreate).toHaveBeenCalledWith("keepalive", {
      periodInMinutes: 25_000 / 60_000,
    });
  });

  it("forwards keepalive alarms to the shared background handle", async () => {
    mocks.restoreFromStorage.mockResolvedValue(true);

    startFirefoxBackground();
    await flushMicrotasks();

    expect(alarmListener).not.toBeNull();

    alarmListener?.({ name: "not-keepalive" });
    expect(mocks.sendKeepalive).not.toHaveBeenCalled();

    alarmListener?.({ name: "keepalive" });
    expect(mocks.sendKeepalive).toHaveBeenCalledTimes(1);
  });

  it("logs startup failures when restoreFromStorage rejects", async () => {
    const error = new Error("restore failed");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.restoreFromStorage.mockRejectedValue(error);

    startFirefoxBackground();
    await flushMicrotasks();

    expect(errorSpy).toHaveBeenCalledWith(
      "[Firefox] Background start failed:",
      error,
    );

    errorSpy.mockRestore();
  });
});
