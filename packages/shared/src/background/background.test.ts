import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProxyManager, TailscaleState, NativeReply } from "../types";
import { initBackground, isValidLoginURL } from "./background";

type MessageListener = (msg: unknown) => void;
type DisconnectListener = (port: unknown) => void;

interface MockPort {
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: MessageListener) => void; _listeners: MessageListener[] };
  onDisconnect: { addListener: (fn: DisconnectListener) => void; _listeners: DisconnectListener[] };
}

function createNativeMockPort(): MockPort {
  const msgListeners: MessageListener[] = [];
  const disListeners: DisconnectListener[] = [];
  return {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: (fn: MessageListener) => { msgListeners.push(fn); },
      _listeners: msgListeners,
    },
    onDisconnect: {
      addListener: (fn: DisconnectListener) => { disListeners.push(fn); },
      _listeners: disListeners,
    },
  };
}

interface MockPopupPort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: MessageListener) => void; _listeners: MessageListener[] };
  onDisconnect: { addListener: (fn: DisconnectListener) => void; _listeners: DisconnectListener[] };
}

function createPopupPort(): MockPopupPort {
  const msgListeners: MessageListener[] = [];
  const disListeners: DisconnectListener[] = [];
  return {
    name: "popup",
    postMessage: vi.fn(),
    onMessage: {
      addListener: (fn: MessageListener) => { msgListeners.push(fn); },
      _listeners: msgListeners,
    },
    onDisconnect: {
      addListener: (fn: DisconnectListener) => { disListeners.push(fn); },
      _listeners: disListeners,
    },
  };
}

describe("isValidLoginURL", () => {
  it("accepts default Tailscale login URLs without a custom coordination server", () => {
    expect(
      isValidLoginURL("https://login.tailscale.com/a/xyz", ""),
    ).toBe(true);
    expect(
      isValidLoginURL("https://controlplane.tailscale.com/a/xyz", null),
    ).toBe(true);
  });

  it("rejects stale Tailscale login URLs when a custom coordination server is set", () => {
    expect(
      isValidLoginURL(
        "https://login.tailscale.com/a/xyz",
        "https://headscale.example.com",
      ),
    ).toBe(false);
  });

  it("accepts delegated HTTPS login URLs for a custom coordination server", () => {
    expect(
      isValidLoginURL(
        "https://auth.example.net/login",
        "https://headscale.example.com",
      ),
    ).toBe(true);
  });

  it("accepts delegated HTTP login URLs only for HTTP custom coordination servers", () => {
    expect(
      isValidLoginURL(
        "http://auth.example.net/login",
        "http://headscale.test:8080",
      ),
    ).toBe(true);
    expect(
      isValidLoginURL(
        "http://auth.example.net/login",
        "https://headscale.example.com",
      ),
    ).toBe(false);
  });
});

describe("initBackground", () => {
  let proxyManager: ProxyManager;
  let nativePort: MockPort;
  let connectListeners: Array<(port: unknown) => void>;

  beforeEach(() => {
    vi.useFakeTimers();

    proxyManager = {
      apply: vi.fn(),
      clear: vi.fn(),
    };

    nativePort = createNativeMockPort();
    connectListeners = [];

    chrome.runtime.connectNative = vi.fn().mockReturnValue(nativePort) as unknown as typeof chrome.runtime.connectNative;
    chrome.runtime.onConnect = {
      addListener: (fn: (port: unknown) => void) => { connectListeners.push(fn); },
    } as unknown as chrome.runtime.ExtensionConnectEvent;
    chrome.runtime.onInstalled = {
      addListener: vi.fn(),
    } as unknown as chrome.events.Event<(details: chrome.runtime.InstalledDetails) => void>;
    chrome.contextMenus = {
      create: vi.fn(),
      onClicked: { addListener: vi.fn() },
    } as unknown as typeof chrome.contextMenus;
    chrome.storage.local.get = vi.fn().mockResolvedValue({ profileId: "test-id" }) as unknown as typeof chrome.storage.local.get;
    chrome.storage.local.set = vi.fn().mockResolvedValue(undefined) as unknown as typeof chrome.storage.local.set;
    chrome.storage.local.remove = vi.fn().mockResolvedValue(undefined) as unknown as typeof chrome.storage.local.remove;
    chrome.storage.session.get = vi.fn().mockResolvedValue({}) as unknown as typeof chrome.storage.session.get;
    chrome.storage.session.set = vi.fn().mockResolvedValue(undefined) as unknown as typeof chrome.storage.session.set;
    chrome.tabs.create = vi.fn().mockResolvedValue(undefined) as unknown as typeof chrome.tabs.create;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function setupBackground() {
    const handle = initBackground(proxyManager, "com.tailscale.test");
    // Let connect() promise resolve
    await vi.advanceTimersByTimeAsync(0);
    return handle;
  }

  function sendNativeMessage(msg: NativeReply) {
    nativePort.onMessage._listeners[0]!(msg);
  }

  function advertiseLoginSupport() {
    sendNativeMessage({
      procRunning: {
        port: 1055,
        pid: 1234,
        version: "0.1.11",
        supportsLogin: true,
      },
    });
  }

  function advertiseCustomControlURLSupport() {
    sendNativeMessage({
      procRunning: {
        port: 1055,
        pid: 1234,
        version: "0.1.11",
        supportsCustomControlURL: true,
      },
    });
  }

  it("returns proxy manager handle", async () => {
    const handle = await setupBackground();
    expect(handle.proxyManager).toBe(proxyManager);
  });

  it("connects to native host on init", async () => {
    await setupBackground();
    expect(chrome.runtime.connectNative).toHaveBeenCalledWith("com.tailscale.test");
  });

  it("sends init message with profile ID", async () => {
    await setupBackground();
    expect(nativePort.postMessage).toHaveBeenCalledWith({
      cmd: "init",
      initID: "test-id",
    });
  });

  describe("native message handling", () => {
    it("updates proxy port on procRunning message", async () => {
      await setupBackground();
      sendNativeMessage({ procRunning: { port: 1055, pid: 1234 } });

      // proxyManager.apply should have been called with state containing new port
      expect(proxyManager.apply).toHaveBeenCalledWith(
        expect.objectContaining({
          proxyPort: 1055,
          proxyEnabled: true,
          supportsNetcheck: false,
          supportsPingPeer: false,
          supportsLogin: false,
        })
      );
    });

    it("sets supportsNetcheck when procRunning advertises it", async () => {
      await setupBackground();
      sendNativeMessage({
        procRunning: { port: 1055, pid: 1234, supportsNetcheck: true },
      });

      expect(proxyManager.apply).toHaveBeenCalledWith(
        expect.objectContaining({ supportsNetcheck: true })
      );
    });

    it("sets supportsPingPeer when procRunning advertises it", async () => {
      await setupBackground();
      sendNativeMessage({
        procRunning: { port: 1055, pid: 1234, supportsPingPeer: true },
      });

      expect(proxyManager.apply).toHaveBeenCalledWith(
        expect.objectContaining({ supportsPingPeer: true })
      );
    });

    it("sets supportsLogin when procRunning advertises it", async () => {
      await setupBackground();
      sendNativeMessage({
        procRunning: { port: 1055, pid: 1234, supportsLogin: true },
      });

      expect(proxyManager.apply).toHaveBeenCalledWith(
        expect.objectContaining({ supportsLogin: true })
      );
    });

    it("sets supportsCustomControlURL when procRunning advertises it", async () => {
      await setupBackground();
      sendNativeMessage({
        procRunning: { port: 1055, pid: 1234, version: "0.1.11", supportsCustomControlURL: true },
      });

      expect(proxyManager.apply).toHaveBeenCalledWith(
        expect.objectContaining({ supportsCustomControlURL: true })
      );
    });

    it("defaults supportsCustomControlURL to false on older helpers", async () => {
      await setupBackground();
      sendNativeMessage({
        procRunning: { port: 1055, pid: 1234 },
      });

      expect(proxyManager.apply).toHaveBeenCalledWith(
        expect.objectContaining({ supportsCustomControlURL: false })
      );
    });

    it("requests status on successful init", async () => {
      await setupBackground();
      sendNativeMessage({ init: {} });

      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "get-status" });
    });

    it("handles init error", async () => {
      await setupBackground();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      sendNativeMessage({ init: { error: "bad init" } });

      expect(proxyManager.apply).toHaveBeenCalledWith(
        expect.objectContaining({ error: "bad init" })
      );
      errorSpy.mockRestore();
    });

    it("applies status update from native host", async () => {
      await setupBackground();
      sendNativeMessage({
        status: {
          backendState: "Running",
          running: true,
          tailnet: "my-tailnet",
          magicDNSSuffix: "my-tailnet.ts.net",
          selfNode: null,
          needsLogin: false,
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });

      expect(proxyManager.apply).toHaveBeenCalledWith(
        expect.objectContaining({
          backendState: "Running",
          tailnet: "my-tailnet",
        })
      );
    });

    it("handles install error from native host", async () => {
      await setupBackground();
      sendNativeMessage({ error: { cmd: "connect", message: "install_error" } });

      expect(proxyManager.apply).toHaveBeenCalledWith(
        expect.objectContaining({ installError: true, hostConnected: false })
      );
    });

    it("handles profiles result", async () => {
      await setupBackground();
      sendNativeMessage({
        profiles: {
          current: { id: "prof1", name: "default" },
          profiles: [
            { id: "prof1", name: "default" },
            { id: "prof2", name: "work" },
          ],
        },
      });

      expect(proxyManager.apply).toHaveBeenCalledWith(
        expect.objectContaining({
          currentProfile: { id: "prof1", name: "default" },
          profiles: expect.arrayContaining([
            expect.objectContaining({ id: "prof2" }),
          ]),
        })
      );
    });

    it("stores exit node suggestion in state without showing a toast", async () => {
      await setupBackground();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.postMessage.mockClear();

      sendNativeMessage({
        exitNodeSuggestion: {
          id: "node-suggested",
          hostname: "best.example.ts.net",
          location: {
            city: "Frankfurt",
            cityCode: "fra",
            country: "Germany",
            countryCode: "DE",
          },
        },
      });

      expect(proxyManager.apply).toHaveBeenCalledWith(
        expect.objectContaining({
          exitNodeSuggestion: expect.objectContaining({ id: "node-suggested" }),
        })
      );
      // Suggestion arrivals must not push a toast — the picker shows them visually.
      const toastCalls = popupPort.postMessage.mock.calls.filter(
        (args: unknown[]) => (args[0] as { type?: string }).type === "toast"
      );
      expect(toastCalls).toHaveLength(0);
    });

    it("stays quiet on suggest-exit-node errors", async () => {
      await setupBackground();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.postMessage.mockClear();

      sendNativeMessage({
        error: { cmd: "suggest-exit-node", message: "no suggestion available" },
      });

      // No toast, no sticky error in state.
      const toastCalls = popupPort.postMessage.mock.calls.filter(
        (args: unknown[]) => (args[0] as { type?: string }).type === "toast"
      );
      expect(toastCalls).toHaveLength(0);
      expect(proxyManager.apply).not.toHaveBeenCalledWith(
        expect.objectContaining({ error: "no suggestion available" })
      );
      warnSpy.mockRestore();
    });
  });

  describe("popup communication", () => {
    it("sends current state to newly connected popup", async () => {
      await setupBackground();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);

      expect(popupPort.postMessage).toHaveBeenCalledWith({
        type: "state",
        state: expect.objectContaining({ hostConnected: false }),
      });
    });

    it("ignores non-popup port connections", async () => {
      await setupBackground();

      const otherPort = createPopupPort();
      otherPort.name = "devtools";
      connectListeners[0]!(otherPort);

      expect(otherPort.postMessage).not.toHaveBeenCalled();
    });

    it("broadcasts state changes to connected popups", async () => {
      await setupBackground();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.postMessage.mockClear();

      // Trigger a state change
      sendNativeMessage({ init: {} });

      expect(popupPort.postMessage).toHaveBeenCalledWith({
        type: "state",
        state: expect.objectContaining({ initialized: true }),
      });
    });

    it("handles toggle message when running", async () => {
      await setupBackground();
      sendNativeMessage({
        status: {
          backendState: "Running",
          running: true,
          tailnet: "t",
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: false,
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "toggle" });

      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "down" });
    });

    it("handles toggle message when stopped", async () => {
      await setupBackground();
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "toggle" });

      // Default state is NoState, toggle should send "up"
      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "up" });
    });

    it("sends info toast when toggle is clicked during Starting state", async () => {
      await setupBackground();
      sendNativeMessage({
        status: {
          backendState: "Starting",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: false,
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.postMessage.mockClear();
      popupPort.onMessage._listeners[0]!({ type: "toggle" });

      expect(nativePort.postMessage).not.toHaveBeenCalled();
      expect(popupPort.postMessage).toHaveBeenCalledWith({
        type: "toast",
        message: "Tailscale is starting up\u2026",
        level: "info",
        persistent: false,
      });
    });

    it("sends info toast when toggle is clicked during NeedsLogin state", async () => {
      await setupBackground();
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.postMessage.mockClear();
      popupPort.onMessage._listeners[0]!({ type: "toggle" });

      expect(nativePort.postMessage).not.toHaveBeenCalled();
      expect(popupPort.postMessage).toHaveBeenCalledWith({
        type: "toast",
        message: "Please log in to Tailscale first.",
        level: "info",
        persistent: false,
      });
    });

    it("sends error toast when toggle is clicked during NeedsMachineAuth state", async () => {
      await setupBackground();
      sendNativeMessage({
        status: {
          backendState: "NeedsMachineAuth",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: false,
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.postMessage.mockClear();
      popupPort.onMessage._listeners[0]!({ type: "toggle" });

      expect(nativePort.postMessage).not.toHaveBeenCalled();
      expect(popupPort.postMessage).toHaveBeenCalledWith({
        type: "toast",
        message: "This machine needs admin approval to join the tailnet.",
        level: "error",
        persistent: false,
      });
    });

    it("sends error toast when toggle is clicked during InUseOtherUser state", async () => {
      await setupBackground();
      sendNativeMessage({
        status: {
          backendState: "InUseOtherUser",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: false,
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.postMessage.mockClear();
      popupPort.onMessage._listeners[0]!({ type: "toggle" });

      expect(nativePort.postMessage).not.toHaveBeenCalled();
      expect(popupPort.postMessage).toHaveBeenCalledWith({
        type: "toast",
        message: "Tailscale is in use by another user on this machine.",
        level: "error",
        persistent: false,
      });
    });

    it("handles set-exit-node message", async () => {
      await setupBackground();
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "set-exit-node", nodeID: "node123" });

      expect(nativePort.postMessage).toHaveBeenCalledWith({
        cmd: "set-exit-node",
        nodeID: "node123",
      });
      expect(proxyManager.apply).toHaveBeenCalledWith(
        expect.objectContaining({ pendingExitNodeID: "node123" }),
      );
      expect(chrome.storage.local.set).toHaveBeenCalledWith({ lastExitNodeID: "node123" });
    });

    it("handles clear-exit-node message", async () => {
      await setupBackground();
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "clear-exit-node" });

      expect(nativePort.postMessage).toHaveBeenCalledWith({
        cmd: "set-exit-node",
        nodeID: "",
      });
      expect(proxyManager.apply).toHaveBeenCalledWith(
        expect.objectContaining({ pendingExitNodeID: "" }),
      );
      expect(chrome.storage.local.remove).toHaveBeenCalledWith("lastExitNodeID");
    });

    it("handles login with valid URL", async () => {
      await setupBackground();
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "https://login.tailscale.com/auth/xyz",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "login" });

      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: "https://login.tailscale.com/auth/xyz",
      });
    });

    it("handles login with tailscale.com URL", async () => {
      await setupBackground();
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "https://tailscale.com/a/xyz",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "login" });

      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: "https://tailscale.com/a/xyz",
      });
    });

    it("handles login with controlplane URL", async () => {
      await setupBackground();
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "https://controlplane.tailscale.com/a/xyz",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "login" });

      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: "https://controlplane.tailscale.com/a/xyz",
      });
    });

    it("does not open arbitrary tailscale subdomain login URLs", async () => {
      await setupBackground();
      advertiseLoginSupport();
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "https://example.tailscale.com/a/xyz",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "login" });

      expect(chrome.tabs.create).not.toHaveBeenCalled();
      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "login" });
    });

    it("does not allow alternate login URL ports", async () => {
      await setupBackground();
      advertiseLoginSupport();
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "https://login.tailscale.com:8443/a/xyz",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "login" });

      expect(chrome.tabs.create).not.toHaveBeenCalled();
      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "login" });
    });

    it("requests a fresh login URL when none is available", async () => {
      await setupBackground();
      advertiseLoginSupport();
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "login" });

      expect(chrome.tabs.create).not.toHaveBeenCalled();
      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "login" });
    });

    it("does not send login command when native helper lacks login support", async () => {
      await setupBackground();
      sendNativeMessage({
        procRunning: { port: 1055, pid: 1234, version: "0.1.11" },
      });
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.postMessage.mockClear();
      popupPort.onMessage._listeners[0]!({ type: "login" });

      expect(nativePort.postMessage).not.toHaveBeenCalled();
      expect(popupPort.postMessage).toHaveBeenCalledWith({
        type: "toast",
        message: "Please update the native helper to request a fresh Tailscale login URL.",
        level: "error",
        persistent: false,
      });
    });

    it("does not send duplicate login requests while waiting for a URL", async () => {
      await setupBackground();
      advertiseLoginSupport();
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.postMessage.mockClear();
      popupPort.onMessage._listeners[0]!({ type: "login" });
      popupPort.onMessage._listeners[0]!({ type: "login" });

      expect(nativePort.postMessage).toHaveBeenCalledTimes(1);
      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "login" });
      expect(popupPort.postMessage).toHaveBeenCalledWith({
        type: "toast",
        message: "Still waiting for Tailscale to return a login URL.",
        level: "info",
        persistent: false,
      });
    });

    it("clears pending login request after timeout", async () => {
      await setupBackground();
      advertiseLoginSupport();
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.postMessage.mockClear();
      popupPort.onMessage._listeners[0]!({ type: "login" });

      await vi.advanceTimersByTimeAsync(30_000);

      expect(popupPort.postMessage).toHaveBeenCalledWith({
        type: "toast",
        message: "Still waiting for a Tailscale login URL. Please try again.",
        level: "error",
        persistent: false,
      });

      nativePort.postMessage.mockClear();
      popupPort.onMessage._listeners[0]!({ type: "login" });
      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "login" });
    });

    it("opens fresh login URL returned after login request", async () => {
      await setupBackground();
      advertiseLoginSupport();
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "login" });

      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "https://login.tailscale.com/a/refreshed",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });

      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: "https://login.tailscale.com/a/refreshed",
      });
    });

    it("shows toast when refreshed login URL is invalid", async () => {
      await setupBackground();
      advertiseLoginSupport();
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.postMessage.mockClear();
      popupPort.onMessage._listeners[0]!({ type: "login" });

      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "https://evil.com/phish",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });

      expect(chrome.tabs.create).not.toHaveBeenCalled();
      expect(popupPort.postMessage).toHaveBeenCalledWith({
        type: "toast",
        message: "Could not open the login URL Tailscale returned.",
        level: "error",
        persistent: false,
      });
    });

    it("rejects login with invalid URL", async () => {
      await setupBackground();
      advertiseLoginSupport();
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "https://evil.com/phish",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });

      const tabCreateSpy = chrome.tabs.create as ReturnType<typeof vi.fn>;
      tabCreateSpy.mockClear();
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "login" });

      expect(chrome.tabs.create).not.toHaveBeenCalled();
      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "login" });
    });

    it("opens login URL from the configured custom coordination server origin", async () => {
      await setupBackground();
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "https://hs.example.com/register/abcdef",
          exitNode: null,
          peers: [],
          prefs: {
            controlURL: "https://hs.example.com",
            exitNodeID: "",
            exitNodeAllowLANAccess: false,
            corpDNS: true,
            shieldsUp: false,
            advertiseExitNode: false,
          },
          health: [],
          error: null,
        },
      });

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "login" });

      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: "https://hs.example.com/register/abcdef",
      });
    });

    it("opens delegated HTTPS login URLs when a custom coordination server is set", async () => {
      await setupBackground();
      advertiseLoginSupport();
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "https://auth.example.net/login",
          exitNode: null,
          peers: [],
          prefs: {
            controlURL: "https://hs.example.com",
            exitNodeID: "",
            exitNodeAllowLANAccess: false,
            corpDNS: true,
            shieldsUp: false,
            advertiseExitNode: false,
          },
          health: [],
          error: null,
        },
      });

      (chrome.tabs.create as ReturnType<typeof vi.fn>).mockClear();
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "login" });

      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: "https://auth.example.net/login",
      });
      expect(nativePort.postMessage).not.toHaveBeenCalled();
    });

    it("rejects non-HTTPS delegated login URLs for HTTPS custom coordination servers", async () => {
      await setupBackground();
      advertiseLoginSupport();
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "http://auth.example.net/login",
          exitNode: null,
          peers: [],
          prefs: {
            controlURL: "https://hs.example.com",
            exitNodeID: "",
            exitNodeAllowLANAccess: false,
            corpDNS: true,
            shieldsUp: false,
            advertiseExitNode: false,
          },
          health: [],
          error: null,
        },
      });

      (chrome.tabs.create as ReturnType<typeof vi.fn>).mockClear();
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "login" });

      expect(chrome.tabs.create).not.toHaveBeenCalled();
      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "login" });
    });

    it("requests a fresh login URL instead of opening a stale default URL after switching custom servers", async () => {
      await setupBackground();
      advertiseLoginSupport();
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "https://login.tailscale.com/a/stale",
          exitNode: null,
          peers: [],
          prefs: {
            controlURL: "https://hs.example.com",
            exitNodeID: "",
            exitNodeAllowLANAccess: false,
            corpDNS: true,
            shieldsUp: false,
            advertiseExitNode: false,
          },
          health: [],
          error: null,
        },
      });

      (chrome.tabs.create as ReturnType<typeof vi.fn>).mockClear();
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "login" });

      expect(chrome.tabs.create).not.toHaveBeenCalled();
      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "login" });
    });

    it("shows login error toast from native host", async () => {
      await setupBackground();
      advertiseLoginSupport();
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.postMessage.mockClear();
      popupPort.onMessage._listeners[0]!({ type: "login" });

      sendNativeMessage({
        error: { cmd: "login", message: "failed to start login: no control connection" },
      });

      expect(popupPort.postMessage).toHaveBeenCalledWith({
        type: "toast",
        message: "failed to start login: no control connection",
        level: "error",
        persistent: false,
      });

      const tabCreateSpy = chrome.tabs.create as ReturnType<typeof vi.fn>;
      tabCreateSpy.mockClear();
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "https://login.tailscale.com/a/late",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });
      expect(chrome.tabs.create).not.toHaveBeenCalled();
    });

    it("handles logout message", async () => {
      await setupBackground();
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "logout" });

      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "logout" });
    });

    it("handles set-pref message", async () => {
      await setupBackground();
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({
        type: "set-pref",
        key: "exitNodeAllowLANAccess",
        value: true,
      });

      expect(nativePort.postMessage).toHaveBeenCalledWith({
        cmd: "set-prefs",
        prefs: { exitNodeAllowLANAccess: true },
      });
    });

    it("forwards controlURL set-pref to native host", async () => {
      await setupBackground();
      advertiseCustomControlURLSupport();
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({
        type: "set-pref",
        key: "controlURL",
        value: "https://hs.example.com",
      });

      expect(nativePort.postMessage).toHaveBeenCalledWith({
        cmd: "set-prefs",
        prefs: { controlURL: "https://hs.example.com" },
      });
    });

    it("forwards empty controlURL (revert to default) to native host", async () => {
      await setupBackground();
      advertiseCustomControlURLSupport();
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({
        type: "set-pref",
        key: "controlURL",
        value: "",
      });

      expect(nativePort.postMessage).toHaveBeenCalledWith({
        cmd: "set-prefs",
        prefs: { controlURL: "" },
      });
    });

    it("rejects controlURL set-pref when native helper lacks support", async () => {
      await setupBackground();
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.postMessage.mockClear();
      popupPort.onMessage._listeners[0]!({
        type: "set-pref",
        key: "controlURL",
        value: "https://hs.example.com",
      });

      expect(nativePort.postMessage).not.toHaveBeenCalled();
      expect(popupPort.postMessage).toHaveBeenCalledWith({
        type: "toast",
        message: "Please update the native helper to change the coordination server.",
        level: "error",
        persistent: false,
      });
    });

    it("allows reverting controlURL to default even when the helper lacks support", async () => {
      await setupBackground();
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({
        type: "set-pref",
        key: "controlURL",
        value: "",
      });

      expect(nativePort.postMessage).toHaveBeenCalledWith({
        cmd: "set-prefs",
        prefs: { controlURL: "" },
      });
    });

    it("rejects a malformed controlURL at the background boundary", async () => {
      await setupBackground();
      advertiseCustomControlURLSupport();
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.postMessage.mockClear();
      popupPort.onMessage._listeners[0]!({
        type: "set-pref",
        key: "controlURL",
        value: "not a url",
      });

      expect(nativePort.postMessage).not.toHaveBeenCalled();
      expect(popupPort.postMessage).toHaveBeenCalledWith({
        type: "toast",
        message: "Enter a valid coordination server URL (http:// or https://).",
        level: "error",
        persistent: false,
      });
    });

    it("keeps waiting for a fresh login URL when a stale default URL arrives for a custom server", async () => {
      await setupBackground();
      advertiseLoginSupport();

      // No browseToURL yet, so the login click asks the host and goes pending.
      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "login" });
      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "login" });

      (chrome.tabs.create as ReturnType<typeof vi.fn>).mockClear();

      const customPrefs = {
        controlURL: "https://hs.example.com",
        exitNodeID: "",
        exitNodeAllowLANAccess: false,
        corpDNS: true,
        shieldsUp: false,
        advertiseExitNode: false,
      };

      // A stale Tailscale-default login URL must not be opened or error out…
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "https://login.tailscale.com/a/stale",
          exitNode: null,
          peers: [],
          prefs: customPrefs,
          health: [],
          error: null,
        },
      });
      expect(chrome.tabs.create).not.toHaveBeenCalled();

      // …and the next, valid custom-origin URL opens (proving we stayed pending).
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "https://hs.example.com/register/fresh",
          exitNode: null,
          peers: [],
          prefs: customPrefs,
          health: [],
          error: null,
        },
      });
      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: "https://hs.example.com/register/fresh",
      });
    });

    it("does not open the stale login URL after switching coordination servers", async () => {
      await setupBackground();
      sendNativeMessage({
        procRunning: {
          port: 1055,
          pid: 1234,
          version: "0.1.11",
          supportsLogin: true,
          supportsCustomControlURL: true,
        },
      });
      // Seed a default-server login URL into state (controlURL still default).
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "https://login.tailscale.com/a/old",
          exitNode: null,
          peers: [],
          prefs: {
            controlURL: "",
            exitNodeID: "",
            exitNodeAllowLANAccess: false,
            corpDNS: true,
            shieldsUp: false,
            advertiseExitNode: false,
          },
          health: [],
          error: null,
        },
      });

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({
        type: "set-pref",
        key: "controlURL",
        value: "https://hs.example.com",
      });

      (chrome.tabs.create as ReturnType<typeof vi.fn>).mockClear();
      nativePort.postMessage.mockClear();

      // Clicking Log In before the host replies must not open the stale default
      // URL; it should request a fresh one for the new server instead.
      popupPort.onMessage._listeners[0]!({ type: "login" });

      expect(chrome.tabs.create).not.toHaveBeenCalled();
      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "login" });
    });

    it("clears the saved exit node when the coordination server changes", async () => {
      await setupBackground();
      sendNativeMessage({
        procRunning: { port: 1055, pid: 1234, version: "0.1.11", supportsCustomControlURL: true },
      });
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: {
            controlURL: "",
            exitNodeID: "",
            exitNodeAllowLANAccess: false,
            corpDNS: true,
            shieldsUp: false,
            advertiseExitNode: false,
          },
          health: [],
          error: null,
        },
      });

      (chrome.storage.local.remove as ReturnType<typeof vi.fn>).mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({
        type: "set-pref",
        key: "controlURL",
        value: "https://hs.example.com",
      });

      expect(chrome.storage.local.remove).toHaveBeenCalledWith("lastExitNodeID");
    });

    it("keeps the saved exit node when re-saving the same coordination server", async () => {
      await setupBackground();
      sendNativeMessage({
        procRunning: { port: 1055, pid: 1234, version: "0.1.11", supportsCustomControlURL: true },
      });
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: {
            controlURL: "https://hs.example.com",
            exitNodeID: "",
            exitNodeAllowLANAccess: false,
            corpDNS: true,
            shieldsUp: false,
            advertiseExitNode: false,
          },
          health: [],
          error: null,
        },
      });

      (chrome.storage.local.remove as ReturnType<typeof vi.fn>).mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({
        type: "set-pref",
        key: "controlURL",
        value: "https://hs.example.com",
      });

      expect(chrome.storage.local.remove).not.toHaveBeenCalled();
    });

    it("handles switch-profile message", async () => {
      await setupBackground();
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "switch-profile", profileID: "prof2" });

      expect(nativePort.postMessage).toHaveBeenCalledWith({
        cmd: "switch-profile",
        profileID: "prof2",
      });
    });

    it("handles new-profile message", async () => {
      await setupBackground();
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "new-profile" });

      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "new-profile" });
    });

    it("handles delete-profile message", async () => {
      await setupBackground();
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "delete-profile", profileID: "prof1" });

      expect(nativePort.postMessage).toHaveBeenCalledWith({
        cmd: "delete-profile",
        profileID: "prof1",
      });
    });

    it("handles send-file message", async () => {
      await setupBackground();
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({
        type: "send-file",
        targetNodeID: "node1",
        name: "test.txt",
        size: 100,
        dataBase64: "dGVzdA==",
      });

      expect(nativePort.postMessage).toHaveBeenCalledWith({
        cmd: "send-file",
        nodeID: "node1",
        fileName: "test.txt",
        fileData: "dGVzdA==",
        fileSize: 100,
      });
    });

    it("handles suggest-exit-node message", async () => {
      await setupBackground();
      nativePort.postMessage.mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "suggest-exit-node" });

      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "suggest-exit-node" });
    });

    it("handles open-admin message", async () => {
      await setupBackground();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "open-admin" });

      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: "https://login.tailscale.com/admin",
      });
    });

    it("handles open-web-client message", async () => {
      await setupBackground();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "open-web-client" });

      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: "http://100.100.100.100",
      });
    });

    it("removes popup port on disconnect", async () => {
      await setupBackground();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.postMessage.mockClear();

      // Disconnect popup
      popupPort.onDisconnect._listeners[0]!(popupPort);

      // Trigger state change - disconnected popup should not receive it
      sendNativeMessage({ init: {} });
      expect(popupPort.postMessage).not.toHaveBeenCalled();
    });
  });

  describe("exit node restoration", () => {
    it("restores saved exit node on first Running status without exit node", async () => {
      (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        profileId: "test-id",
        lastExitNodeID: "saved-exit-node",
      });

      await setupBackground();
      nativePort.postMessage.mockClear();

      sendNativeMessage({
        status: {
          backendState: "Running",
          running: true,
          tailnet: "t",
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: false,
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });

      // Let storage.get promise resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(nativePort.postMessage).toHaveBeenCalledWith({
        cmd: "set-exit-node",
        nodeID: "saved-exit-node",
      });
    });

    it("does not restore exit node if already has one", async () => {
      await setupBackground();
      nativePort.postMessage.mockClear();

      sendNativeMessage({
        status: {
          backendState: "Running",
          running: true,
          tailnet: "t",
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: false,
          browseToURL: "",
          exitNode: { id: "current-exit", hostname: "exit", location: null, online: true },
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });

      await vi.advanceTimersByTimeAsync(0);

      // Should not have called set-exit-node
      expect(nativePort.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ cmd: "set-exit-node" })
      );
    });
  });

  describe("native host state change", () => {
    it("clears state when disconnected", async () => {
      await setupBackground();

      // Simulate native host connection established
      sendNativeMessage({ pong: {} });

      // Simulate disconnect
      nativePort.onDisconnect._listeners[0]!(nativePort);

      expect(proxyManager.apply).toHaveBeenCalledWith(
        expect.objectContaining({
          hostConnected: false,
          initialized: false,
          proxyPort: null,
          proxyEnabled: false,
        })
      );
    });

    it("clears pending login request when disconnected", async () => {
      await setupBackground();
      advertiseLoginSupport();
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.postMessage.mockClear();
      nativePort.postMessage.mockClear();
      popupPort.onMessage._listeners[0]!({ type: "login" });
      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "login" });

      nativePort.onDisconnect._listeners[0]!(nativePort);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(popupPort.postMessage).not.toHaveBeenCalledWith({
        type: "toast",
        message: "Still waiting for a Tailscale login URL. Please try again.",
        level: "error",
        persistent: false,
      });

      nativePort.postMessage.mockClear();
      sendNativeMessage({
        procRunning: {
          port: 1055,
          pid: 1234,
          version: "0.1.11",
          supportsLogin: true,
        },
      });
      sendNativeMessage({
        status: {
          backendState: "NeedsLogin",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: true,
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      });
      popupPort.onMessage._listeners[0]!({ type: "login" });

      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "login" });
    });
  });

  describe("domain split", () => {
    it("restores saved domainSplit from storage on startup", async () => {
      (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>) = vi
        .fn()
        .mockImplementation((key: string) => {
          if (key === "domainSplitConfig") {
            return Promise.resolve({
              domainSplitConfig: {
                mode: "only",
                domains: ["teams.microsoft.com"],
              },
            });
          }
          return Promise.resolve({ profileId: "test-id" });
        });

      await setupBackground();
      await vi.advanceTimersByTimeAsync(0);

      expect(proxyManager.apply).toHaveBeenCalledWith(
        expect.objectContaining({
          domainSplit: {
            mode: "only",
            domains: ["teams.microsoft.com"],
          },
        }),
      );
    });

    it("updates state when domainSplit storage changes", async () => {
      await setupBackground();
      await vi.advanceTimersByTimeAsync(0);

      const listeners = (chrome.storage.onChanged as unknown as {
        _listeners: Array<
          (changes: Record<string, { newValue?: unknown }>, area: string) => void
        >;
      })._listeners;
      const listener = listeners[listeners.length - 1]!;

      (proxyManager.apply as ReturnType<typeof vi.fn>).mockClear();
      await listener(
        {
          domainSplitConfig: {
            newValue: {
              mode: "bypass",
              domains: ["outlook.office.com"],
            },
          },
        },
        "local",
      );

      expect(proxyManager.apply).toHaveBeenCalledWith(
        expect.objectContaining({
          domainSplit: {
            mode: "bypass",
            domains: ["outlook.office.com"],
          },
        }),
      );
    });

    it("ignores no-op storage changes", async () => {
      (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>) = vi
        .fn()
        .mockImplementation((key: string) => {
          if (key === "domainSplitConfig") {
            return Promise.resolve({
              domainSplitConfig: {
                mode: "bypass",
                domains: ["example.com"],
              },
            });
          }
          return Promise.resolve({ profileId: "test-id" });
        });

      await setupBackground();
      await vi.advanceTimersByTimeAsync(0);

      const listeners = (chrome.storage.onChanged as unknown as {
        _listeners: Array<
          (changes: Record<string, { newValue?: unknown }>, area: string) => void
        >;
      })._listeners;
      const listener = listeners[listeners.length - 1]!;

      (proxyManager.apply as ReturnType<typeof vi.fn>).mockClear();
      await listener(
        {
          domainSplitConfig: {
            newValue: { mode: "bypass", domains: ["example.com"] },
          },
        },
        "local",
      );
      expect(proxyManager.apply).not.toHaveBeenCalled();
    });

    it("handles set-domain-split popup message", async () => {
      await setupBackground();
      await vi.advanceTimersByTimeAsync(0);
      (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({
        type: "set-domain-split",
        config: { mode: "only", domains: ["WORK.example.com", "bad domain"] },
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(proxyManager.apply).toHaveBeenCalledWith(
        expect.objectContaining({
          domainSplit: {
            mode: "only",
            domains: ["work.example.com"],
          },
        }),
      );
      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        domainSplitConfig: {
          mode: "only",
          domains: ["work.example.com"],
        },
      });
    });
  });

  describe("auto-connect on start", () => {
    function stoppedStatus(): NativeReply {
      return {
        status: {
          backendState: "Stopped",
          running: false,
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: false,
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      };
    }

    function statusWith(backendState: TailscaleState["backendState"]): NativeReply {
      return {
        status: {
          backendState,
          running: backendState === "Running",
          tailnet: null,
          magicDNSSuffix: "",
          selfNode: null,
          needsLogin: backendState === "NeedsLogin",
          browseToURL: "",
          exitNode: null,
          peers: [],
          prefs: null,
          health: [],
          error: null,
        },
      };
    }

    it("sends `up` once when status is Stopped and pref is on", async () => {
      (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        profileId: "test-id",
        autoConnectOnStart: true,
      });

      await setupBackground();
      nativePort.postMessage.mockClear();

      sendNativeMessage(stoppedStatus());
      await vi.advanceTimersByTimeAsync(0);

      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "up" });
      expect(chrome.storage.session.set).toHaveBeenCalledWith({
        autoConnectHandled: true,
      });
    });

    it("sends `up` if status arrives before the pref finishes hydrating", async () => {
      let resolveAutoConnectPref!: (value: Record<string, unknown>) => void;
      const autoConnectPref = new Promise<Record<string, unknown>>((resolve) => {
        resolveAutoConnectPref = resolve;
      });
      (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(
        (key: string) => {
          if (key === "autoConnectOnStart") return autoConnectPref;
          if (key === "profileId") {
            return Promise.resolve({ profileId: "test-id" });
          }
          return Promise.resolve({});
        },
      );

      await setupBackground();
      nativePort.postMessage.mockClear();

      sendNativeMessage(stoppedStatus());
      await vi.advanceTimersByTimeAsync(0);
      expect(nativePort.postMessage).not.toHaveBeenCalledWith({ cmd: "up" });

      resolveAutoConnectPref({ autoConnectOnStart: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "up" });
      expect(chrome.storage.session.set).toHaveBeenCalledWith({
        autoConnectHandled: true,
      });
    });

    it("fires for NoState the same as Stopped", async () => {
      (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        profileId: "test-id",
        autoConnectOnStart: true,
      });

      await setupBackground();
      nativePort.postMessage.mockClear();

      sendNativeMessage(statusWith("NoState"));
      await vi.advanceTimersByTimeAsync(0);

      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "up" });
    });

    it("does not send `up` when the session flag is already set", async () => {
      (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        profileId: "test-id",
        autoConnectOnStart: true,
      });
      (chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoConnectHandled: true,
      });

      await setupBackground();
      nativePort.postMessage.mockClear();

      sendNativeMessage(stoppedStatus());
      await vi.advanceTimersByTimeAsync(0);

      expect(nativePort.postMessage).not.toHaveBeenCalledWith({ cmd: "up" });
    });

    it("does not send `up` when the pref is off", async () => {
      await setupBackground();
      nativePort.postMessage.mockClear();

      sendNativeMessage(stoppedStatus());
      await vi.advanceTimersByTimeAsync(0);

      expect(nativePort.postMessage).not.toHaveBeenCalledWith({ cmd: "up" });
      expect(chrome.storage.session.set).not.toHaveBeenCalled();
    });

    for (const skipState of [
      "NeedsLogin",
      "NeedsMachineAuth",
      "InUseOtherUser",
      "Starting",
      "Running",
    ] as const) {
      it(`does not send \`up\` when status is ${skipState}`, async () => {
        (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
          profileId: "test-id",
          autoConnectOnStart: true,
        });

        await setupBackground();
        nativePort.postMessage.mockClear();

        sendNativeMessage(statusWith(skipState));
        await vi.advanceTimersByTimeAsync(0);

        expect(nativePort.postMessage).not.toHaveBeenCalledWith({ cmd: "up" });
      });
    }

    it("marks the session flag when the user manually disconnects from Running", async () => {
      await setupBackground();
      sendNativeMessage(statusWith("Running"));
      nativePort.postMessage.mockClear();
      (chrome.storage.session.set as ReturnType<typeof vi.fn>).mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "toggle" });
      await vi.advanceTimersByTimeAsync(0);

      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "down" });
      expect(chrome.storage.session.set).toHaveBeenCalledWith({
        autoConnectHandled: true,
      });
    });

    it("does not mark the session flag when manually connecting from Stopped", async () => {
      await setupBackground();
      (chrome.storage.session.set as ReturnType<typeof vi.fn>).mockClear();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "toggle" });
      await vi.advanceTimersByTimeAsync(0);

      expect(chrome.storage.session.set).not.toHaveBeenCalled();
    });

    it("set-auto-connect-on-start persists to storage and broadcasts state", async () => {
      await setupBackground();

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.postMessage.mockClear();

      popupPort.onMessage._listeners[0]!({
        type: "set-auto-connect-on-start",
        value: true,
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        autoConnectOnStart: true,
      });
      expect(popupPort.postMessage).toHaveBeenCalledWith({
        type: "state",
        state: expect.objectContaining({ autoConnectOnStart: true }),
      });
    });

    it("hydrates autoConnectOnStart from storage on startup", async () => {
      (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        profileId: "test-id",
        autoConnectOnStart: true,
      });

      await setupBackground();
      await vi.advanceTimersByTimeAsync(0);

      expect(proxyManager.apply).toHaveBeenCalledWith(
        expect.objectContaining({ autoConnectOnStart: true }),
      );
    });
  });

  describe("uiSurface wiring", () => {
    beforeEach(() => {
      (chrome.sidePanel.setPanelBehavior as ReturnType<typeof vi.fn>).mockClear();
      (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>) = vi.fn(
        () => Promise.resolve({ uiSurface: "sidePanel" }),
      );
    });

    it("calls applyUiSurface with the persisted setting on init", async () => {
      const proxy: ProxyManager = { apply: vi.fn(), clear: vi.fn() };
      initBackground(proxy, "test-host", { browserKind: "chrome" });
      // applyUiSurface is async; flush the microtask queue.
      await Promise.resolve();
      await Promise.resolve();
      expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({
        openPanelOnActionClick: true,
      });
    });

    it("re-applies when uiSurface changes in storage", async () => {
      const proxy: ProxyManager = { apply: vi.fn(), clear: vi.fn() };
      initBackground(proxy, "test-host", { browserKind: "chrome" });
      await Promise.resolve();
      (chrome.sidePanel.setPanelBehavior as ReturnType<typeof vi.fn>).mockClear();

      const listeners =
        (chrome.storage.onChanged as unknown as {
          _listeners: Array<
            (changes: Record<string, { newValue?: unknown }>, area: string) => void
          >;
        })._listeners;
      await listeners[listeners.length - 1]!({ uiSurface: { newValue: "popup" } }, "local");
      await Promise.resolve();

      expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({
        openPanelOnActionClick: false,
      });
    });
  });

  describe("keepalive", () => {
    it("sends ping at keepalive interval when connected", async () => {
      await setupBackground();

      // Simulate receiving a message - NativeHostConnection calls onStateChange(true)
      // which sets hostConnected: true in the store
      sendNativeMessage({ pong: {} });
      nativePort.postMessage.mockClear();

      // Advance past keepalive interval (25s)
      await vi.advanceTimersByTimeAsync(25_000);

      expect(nativePort.postMessage).toHaveBeenCalledWith({ cmd: "ping" });
    });

    it("does not send ping when not connected", async () => {
      await setupBackground();
      nativePort.postMessage.mockClear();

      // State starts with hostConnected: false (no message received yet to trigger state change)
      // But NativeHostConnection may have already called onStateChange(true) on first message
      // So we need to ensure no messages were received

      // Advance past keepalive interval
      await vi.advanceTimersByTimeAsync(25_000);

      // hostConnected is false in initial state, so ping should not be sent
      // However, the NativeHostConnection connect() flow triggers handleMessage
      // which calls onStateChange(true). Let's check what actually happens.
      // In this case no native message was sent, so hostConnected stays false.
      expect(nativePort.postMessage).not.toHaveBeenCalledWith({ cmd: "ping" });
    });
  });
});
