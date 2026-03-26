import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProxyManager, TailscaleState, NativeReply } from "../types";
import { initBackground } from "./background";

// ---- Mock types for port simulation ----

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

// ---- Mock popup port ----

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
    } as unknown as chrome.runtime.InstalledEvent;
    chrome.contextMenus = {
      create: vi.fn(),
      onClicked: { addListener: vi.fn() },
    } as unknown as typeof chrome.contextMenus;
    chrome.storage.local.get = vi.fn().mockResolvedValue({ profileId: "test-id" }) as unknown as typeof chrome.storage.local.get;
    chrome.storage.local.set = vi.fn().mockResolvedValue(undefined) as unknown as typeof chrome.storage.local.set;
    chrome.storage.local.remove = vi.fn().mockResolvedValue(undefined) as unknown as typeof chrome.storage.local.remove;
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
        expect.objectContaining({ proxyPort: 1055, proxyEnabled: true })
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

    it("rejects login with invalid URL", async () => {
      await setupBackground();
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

      const popupPort = createPopupPort();
      connectListeners[0]!(popupPort);
      popupPort.onMessage._listeners[0]!({ type: "login" });

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
