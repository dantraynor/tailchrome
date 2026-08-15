import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import {
  NativeHostConnection,
  isValidNativeReply,
  type NativeConnectionEventHandler,
  type NativeMessageHandler,
} from "./native-host";

// @types/chrome 0.2.x declares runtime.lastError as a `const` (read-only)
// binding, so tests that simulate connectNative errors have to go through an
// unknown-typed view of chrome.runtime to assign it.
function setChromeLastError(error: chrome.runtime.LastError | undefined): void {
  (chrome.runtime as unknown as { lastError: chrome.runtime.LastError | undefined }).lastError = error;
}

// Helper to create a mock port with accessible listener arrays
function createMockPort() {
  const messageListeners: Array<(msg: unknown) => void> = [];
  const disconnectListeners: Array<(port: unknown) => void> = [];
  return {
    port: {
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: {
        addListener: (fn: (msg: unknown) => void) => {
          messageListeners.push(fn);
        },
      },
      onDisconnect: {
        addListener: (fn: (port: unknown) => void) => {
          disconnectListeners.push(fn);
        },
      },
    },
    messageListeners,
    disconnectListeners,
  };
}

function makeValidStatus() {
  return {
    backendState: "Running",
    running: true,
    tailnet: "example.ts.net",
    magicDNSSuffix: "example.ts.net",
    needsLogin: false,
    peers: [],
    health: [],
  };
}

describe("NativeHostConnection", () => {
  let connectNativeSpy: ReturnType<typeof vi.fn>;
  let storageGetSpy: ReturnType<typeof vi.fn>;
  let storageSetSpy: ReturnType<typeof vi.fn>;
  let mockPort: ReturnType<typeof createMockPort>;
  let onMessage: Mock<NativeMessageHandler>;
  let onStateChange: Mock<NativeConnectionEventHandler>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockPort = createMockPort();
    connectNativeSpy = vi.fn().mockReturnValue(mockPort.port);
    storageGetSpy = vi.fn().mockResolvedValue({ profileId: "test-profile-id" });
    storageSetSpy = vi.fn().mockResolvedValue(undefined);

    chrome.runtime.connectNative = connectNativeSpy as unknown as typeof chrome.runtime.connectNative;
    chrome.storage.local.get = storageGetSpy as unknown as typeof chrome.storage.local.get;
    chrome.storage.local.set = storageSetSpy as unknown as typeof chrome.storage.local.set;
    setChromeLastError(undefined);

    onMessage = vi.fn<NativeMessageHandler>();
    onStateChange = vi.fn<NativeConnectionEventHandler>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("connect", () => {
    it("connects to native host and sends init message", async () => {
      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      expect(connectNativeSpy).toHaveBeenCalledWith("com.tailscale.test");
      expect(mockPort.port.postMessage).toHaveBeenCalledWith({
        cmd: "init",
        initID: "test-profile-id",
      });
    });

    it("retrieves existing profile ID from storage", async () => {
      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      expect(storageGetSpy).toHaveBeenCalledWith("profileId");
      expect(mockPort.port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ initID: "test-profile-id" })
      );
    });

    it("creates new profile ID when none exists", async () => {
      storageGetSpy.mockResolvedValue({});
      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      expect(storageSetSpy).toHaveBeenCalledWith({
        profileId: expect.any(String),
      });
    });

    it("disconnects existing port before reconnecting", async () => {
      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      const firstPort = mockPort.port;
      mockPort = createMockPort();
      connectNativeSpy.mockReturnValue(mockPort.port);

      await conn.connect();
      expect(firstPort.disconnect).toHaveBeenCalled();
    });

    it("serializes overlapping connects while profile storage is pending", async () => {
      let resolveStorage!: (value: { profileId: string }) => void;
      storageGetSpy.mockReturnValue(
        new Promise((resolve) => {
          resolveStorage = resolve;
        }),
      );
      const conn = new NativeHostConnection(
        "com.tailscale.test",
        onMessage,
        onStateChange,
      );

      const first = conn.connect();
      const second = conn.connect();
      expect(first).toBe(second);
      expect(connectNativeSpy).not.toHaveBeenCalled();

      resolveStorage({ profileId: "test-profile-id" });
      await Promise.all([first, second]);
      expect(connectNativeSpy).toHaveBeenCalledTimes(1);
    });

    it("ignores disconnect events from a replaced port", async () => {
      const conn = new NativeHostConnection(
        "com.tailscale.test",
        onMessage,
        onStateChange,
      );
      await conn.connect();
      const first = mockPort;

      const second = createMockPort();
      connectNativeSpy.mockReturnValue(second.port);
      await conn.connect();

      first.disconnectListeners[0]!(first.port);
      second.messageListeners[0]!({ pong: {} });
      expect(onStateChange).toHaveBeenLastCalledWith({ type: "connected" });
    });

    it("reports a synchronous connectNative exception as start failed", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      connectNativeSpy.mockImplementation(() => {
        throw new Error(
          "launch failed for /Users/alice/Library/Tailchrome https://example.test",
        );
      });
      const conn = new NativeHostConnection(
        "com.tailscale.test",
        onMessage,
        onStateChange,
      );

      await conn.connect();

      expect(onStateChange).toHaveBeenCalledWith({
        type: "disconnected",
        failure: {
          kind: "helper-start-failed",
          diagnosticCode: "native-connect-threw",
          diagnosticMessage:
            "launch failed for [redacted-home]/Library/Tailchrome [redacted-url]",
        },
        reconnecting: true,
      });
      vi.restoreAllMocks();
    });

    it("reports an initial init post failure as start failed", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      mockPort.port.postMessage.mockImplementation(() => {
        throw new Error("init port closed");
      });
      const conn = new NativeHostConnection(
        "com.tailscale.test",
        onMessage,
        onStateChange,
      );

      await conn.connect();

      expect(onStateChange).toHaveBeenCalledWith({
        type: "disconnected",
        failure: {
          kind: "helper-start-failed",
          diagnosticCode: "native-init-send-failed",
          diagnosticMessage: "init port closed",
        },
        reconnecting: true,
      });
      vi.restoreAllMocks();
    });
  });

  describe("wantRunning resolver", () => {
    it("includes wantRunning: false in the init message when the resolver resolves false", async () => {
      const getWantRunning = vi.fn().mockResolvedValue(false);
      const conn = new NativeHostConnection(
        "com.tailscale.test",
        onMessage,
        onStateChange,
        undefined,
        getWantRunning,
      );
      await conn.connect();

      expect(getWantRunning).toHaveBeenCalled();
      expect(mockPort.port.postMessage).toHaveBeenCalledWith({
        cmd: "init",
        initID: "test-profile-id",
        wantRunning: false,
      });
    });

    it("includes wantRunning: true in the init message when the resolver resolves true", async () => {
      const getWantRunning = vi.fn().mockResolvedValue(true);
      const conn = new NativeHostConnection(
        "com.tailscale.test",
        onMessage,
        onStateChange,
        undefined,
        getWantRunning,
      );
      await conn.connect();

      expect(mockPort.port.postMessage).toHaveBeenCalledWith({
        cmd: "init",
        initID: "test-profile-id",
        wantRunning: true,
      });
    });

    it("resolves the resolver before opening the native port", async () => {
      const order: string[] = [];
      const getWantRunning = vi.fn().mockImplementation(async () => {
        order.push("resolve");
        return true;
      });
      connectNativeSpy.mockImplementation(() => {
        order.push("connectNative");
        return mockPort.port;
      });
      const conn = new NativeHostConnection(
        "com.tailscale.test",
        onMessage,
        onStateChange,
        undefined,
        getWantRunning,
      );
      await conn.connect();

      expect(order).toEqual(["resolve", "connectNative"]);
    });

    it("omits wantRunning from the init message when no resolver is given", async () => {
      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      const initCall = mockPort.port.postMessage.mock.calls.find(
        (call) => (call[0] as { cmd: string }).cmd === "init",
      );
      expect(initCall![0]).toEqual({ cmd: "init", initID: "test-profile-id" });
      expect(initCall![0]).not.toHaveProperty("wantRunning");
    });

    it("omits wantRunning from the init message when the resolver resolves undefined", async () => {
      const getWantRunning = vi.fn().mockResolvedValue(undefined);
      const conn = new NativeHostConnection(
        "com.tailscale.test",
        onMessage,
        onStateChange,
        undefined,
        getWantRunning,
      );
      await conn.connect();

      expect(mockPort.port.postMessage).toHaveBeenCalledWith({
        cmd: "init",
        initID: "test-profile-id",
      });
      const initCall = mockPort.port.postMessage.mock.calls.find(
        (call) => (call[0] as { cmd: string }).cmd === "init",
      );
      expect(initCall![0]).not.toHaveProperty("wantRunning");
    });

    it("omits wantRunning and still sends init when the resolver rejects", async () => {
      const getWantRunning = vi.fn().mockRejectedValue(new Error("boom"));
      const conn = new NativeHostConnection(
        "com.tailscale.test",
        onMessage,
        onStateChange,
        undefined,
        getWantRunning,
      );
      await conn.connect();

      expect(mockPort.port.postMessage).toHaveBeenCalledWith({
        cmd: "init",
        initID: "test-profile-id",
      });
      expect(onStateChange).toHaveBeenCalledWith({
        type: "diagnostic",
        diagnosticCode: "native-want-running-failed",
        diagnosticMessage: "boom",
      });
    });
  });

  describe("message handling", () => {
    it("notifies state change on first message received", async () => {
      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      // Simulate a message from native host
      mockPort.messageListeners[0]!({ pong: {} });

      expect(onStateChange).toHaveBeenCalledWith({ type: "connected" });
      expect(onMessage).toHaveBeenCalledWith({ pong: {} });
    });

    it("only notifies state change once for multiple messages", async () => {
      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      mockPort.messageListeners[0]!({ pong: {} });
      mockPort.messageListeners[0]!({ pong: {} });
      mockPort.messageListeners[0]!({ pong: {} });

      expect(onStateChange).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledTimes(3);
    });

    it("forwards all messages to onMessage handler", async () => {
      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      const statusMsg = { status: makeValidStatus() };
      mockPort.messageListeners[0]!(statusMsg);

      expect(onMessage).toHaveBeenCalledWith(statusMsg);
    });

    it.each([
      undefined,
      null,
      {},
      { unknown: true },
      { init: "bad" },
      {
        status: {
          ...makeValidStatus(),
          peers: {},
        },
      },
      {
        pong: {},
        status: {
          ...makeValidStatus(),
          health: "not-an-array",
        },
      },
    ])(
      "does not mark an invalid native reply healthy: %j",
      async (invalidReply) => {
        const conn = new NativeHostConnection(
          "com.tailscale.test",
          onMessage,
          onStateChange,
        );
        await conn.connect();

        mockPort.messageListeners[0]!(invalidReply);

        expect(onMessage).not.toHaveBeenCalled();
        expect(onStateChange).not.toHaveBeenCalledWith({ type: "connected" });
        expect(onStateChange).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "diagnostic",
            diagnosticCode: "native-message-invalid",
            diagnosticMessage: null,
          }),
        );
      },
    );
  });

  describe("send", () => {
    it("sends message through port", async () => {
      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      conn.send({ cmd: "get-status" });
      expect(mockPort.port.postMessage).toHaveBeenCalledWith({ cmd: "get-status" });
    });

    it("logs warning when sending without connection", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);

      conn.send({ cmd: "ping" });
      expect(warnSpy).toHaveBeenCalledWith(
        "[NativeHost] Cannot send, not connected:",
        "ping"
      );
      warnSpy.mockRestore();
    });

    it("handles postMessage errors gracefully", async () => {
      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      mockPort.port.postMessage.mockImplementation(() => {
        throw new Error("port closed");
      });

      // Should not throw
      conn.send({ cmd: "ping" });
      expect(onStateChange).toHaveBeenCalledWith({
        type: "diagnostic",
        diagnosticCode: "native-send-ping-failed",
        diagnosticMessage: "port closed",
      });
    });
  });

  describe("disconnect", () => {
    it("disconnects port and notifies state change", async () => {
      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      // Simulate first message so connectedNotified is true
      mockPort.messageListeners[0]!({ pong: {} });
      onStateChange.mockClear();

      conn.disconnect();
      expect(mockPort.port.disconnect).toHaveBeenCalled();
      expect(onStateChange).toHaveBeenCalledWith({
        type: "disconnected",
        failure: null,
        reconnecting: false,
      });
    });

    it("does not reconnect after intentional disconnect", async () => {
      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      conn.disconnect();

      // Simulate a disconnect event that would normally trigger reconnect
      mockPort.disconnectListeners[0]!(mockPort.port);

      // Advance timers - no reconnect should happen
      await vi.advanceTimersByTimeAsync(60_000);
      expect(connectNativeSpy).toHaveBeenCalledTimes(1); // Only initial
    });
  });

  describe("reconnection", () => {
    it("schedules reconnect on unexpected disconnect", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});

      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      // Simulate unexpected disconnect
      mockPort.disconnectListeners[0]!(mockPort.port);

      // Set up a new mock port for reconnection
      const newMock = createMockPort();
      connectNativeSpy.mockReturnValue(newMock.port);

      // Advance past reconnect delay (1000ms base)
      await vi.advanceTimersByTimeAsync(1_000);

      expect(connectNativeSpy).toHaveBeenCalledTimes(2);

      vi.restoreAllMocks();
    });

    it("applies exponential backoff on repeated disconnects", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});

      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      // First disconnect - should reconnect after 1000ms
      mockPort.disconnectListeners[0]!(mockPort.port);

      const newMock1 = createMockPort();
      connectNativeSpy.mockReturnValue(newMock1.port);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(connectNativeSpy).toHaveBeenCalledTimes(2);

      // Second disconnect - should reconnect after 2000ms (doubled)
      newMock1.disconnectListeners[0]!(newMock1.port);

      const newMock2 = createMockPort();
      connectNativeSpy.mockReturnValue(newMock2.port);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(connectNativeSpy).toHaveBeenCalledTimes(2); // Not yet

      await vi.advanceTimersByTimeAsync(1);
      expect(connectNativeSpy).toHaveBeenCalledTimes(3);

      vi.restoreAllMocks();
    });

    it("resets backoff delay after successful message", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});

      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      // Disconnect and reconnect - builds up backoff
      mockPort.disconnectListeners[0]!(mockPort.port);
      const newMock = createMockPort();
      connectNativeSpy.mockReturnValue(newMock.port);
      await vi.advanceTimersByTimeAsync(1_000);

      // Receive a message - resets backoff
      newMock.messageListeners[0]!({ pong: {} });

      // Disconnect again - should use base delay (1000ms), not doubled
      newMock.disconnectListeners[0]!(newMock.port);
      const newMock2 = createMockPort();
      connectNativeSpy.mockReturnValue(newMock2.port);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(connectNativeSpy).toHaveBeenCalledTimes(3);

      vi.restoreAllMocks();
    });

    it("classifies Chromium native-host discovery failure as unavailable", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});

      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      // Simulate disconnect with "not found" error
      setChromeLastError({
        message: "Specified native messaging host not found",
      });
      mockPort.disconnectListeners[0]!(mockPort.port);

      expect(onStateChange).toHaveBeenCalledWith({
        type: "disconnected",
        failure: {
          kind: "helper-unavailable",
          diagnosticCode: "native-host-unavailable",
          diagnosticMessage: "Specified native messaging host not found",
        },
        reconnecting: false,
      });

      setChromeLastError(undefined);
      vi.restoreAllMocks();
    });

    it("classifies Firefox native-host discovery failure as unavailable", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});

      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      // Firefox-style error via port.error
      setChromeLastError(undefined);
      Object.assign(mockPort.port, {
        error: { message: "No such native application com.tailscale.test" },
      });
      mockPort.disconnectListeners[0]!(mockPort.port);

      expect(onStateChange).toHaveBeenCalledWith({
        type: "disconnected",
        failure: {
          kind: "helper-unavailable",
          diagnosticCode: "native-host-unavailable",
          diagnosticMessage: "No such native application [redacted-host]",
        },
        reconnecting: false,
      });

      vi.restoreAllMocks();
    });

    it("classifies a forbidden native host as not allowed", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      const conn = new NativeHostConnection(
        "com.tailscale.test",
        onMessage,
        onStateChange,
      );
      await conn.connect();

      setChromeLastError({
        message: "Access to the specified native messaging host is forbidden.",
      });
      mockPort.disconnectListeners[0]!(mockPort.port);

      expect(onStateChange).toHaveBeenCalledWith({
        type: "disconnected",
        failure: {
          kind: "helper-not-allowed",
          diagnosticCode: "native-host-not-allowed",
          diagnosticMessage:
            "Access to the specified native messaging host is forbidden.",
        },
        reconnecting: false,
      });
      setChromeLastError(undefined);
      vi.restoreAllMocks();
    });

    it("classifies an unknown disconnect before health as start failed", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      const conn = new NativeHostConnection(
        "com.tailscale.test",
        onMessage,
        onStateChange,
      );
      await conn.connect();

      mockPort.disconnectListeners[0]!(mockPort.port);

      expect(onStateChange).toHaveBeenCalledWith({
        type: "disconnected",
        failure: {
          kind: "helper-start-failed",
          diagnosticCode: "native-host-start-failed",
          diagnosticMessage: null,
        },
        reconnecting: true,
      });
      vi.restoreAllMocks();
    });

    it("classifies a disconnect after one valid message as stopped", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      const conn = new NativeHostConnection(
        "com.tailscale.test",
        onMessage,
        onStateChange,
      );
      await conn.connect();
      mockPort.messageListeners[0]!({ pong: {} });
      onStateChange.mockClear();

      setChromeLastError({ message: "port closed unexpectedly" });
      mockPort.disconnectListeners[0]!(mockPort.port);

      expect(onStateChange).toHaveBeenCalledWith({
        type: "disconnected",
        failure: {
          kind: "helper-stopped",
          diagnosticCode: "native-host-stopped",
          diagnosticMessage: "port closed unexpectedly",
        },
        reconnecting: true,
      });
      setChromeLastError(undefined);
      vi.restoreAllMocks();
    });
  });

  describe("cancels reconnect timer on new connect", () => {
    it("clears pending reconnect when connect is called", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});

      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      // Trigger reconnect schedule
      mockPort.disconnectListeners[0]!(mockPort.port);

      // Before timer fires, connect manually
      const newMock = createMockPort();
      connectNativeSpy.mockReturnValue(newMock.port);
      await conn.connect();

      // Advance past old timer - should not cause extra connect
      await vi.advanceTimersByTimeAsync(5_000);
      expect(connectNativeSpy).toHaveBeenCalledTimes(2); // Initial + manual

      vi.restoreAllMocks();
    });
  });
});

describe("isValidNativeReply", () => {
  it("accepts recognized reply envelopes and rejects arbitrary objects", () => {
    expect(isValidNativeReply({ procRunning: { port: 1055, pid: 1 } })).toBe(
      true,
    );
    expect(isValidNativeReply({ init: {} })).toBe(true);
    expect(isValidNativeReply({ pong: {} })).toBe(true);
    // Unknown fields from newer helpers are tolerated, not rejected.
    expect(isValidNativeReply({ init: { arbitrary: "data" } })).toBe(true);
    expect(isValidNativeReply({ pong: { arbitrary: "data" } })).toBe(true);
    expect(isValidNativeReply({ status: makeValidStatus() })).toBe(true);
    // Helpers before v0.1.7 omit advertiseExitNode from prefs.
    expect(
      isValidNativeReply({
        status: {
          ...makeValidStatus(),
          prefs: {
            exitNodeID: "",
            exitNodeAllowLANAccess: false,
            corpDNS: true,
            shieldsUp: false,
          },
        },
      }),
    ).toBe(true);
    expect(
      isValidNativeReply({
        exitNodeSuggestion: {
          id: "node-id",
          hostname: "exit-node",
        },
      }),
    ).toBe(true);
    expect(
      isValidNativeReply({
        fileSendProgress: {
          targetNodeID: "node-id",
          name: "file.txt",
          percent: 100,
          done: true,
        },
      }),
    ).toBe(true);
    expect(
      isValidNativeReply({
        status: {
          ...makeValidStatus(),
          peers: [
            {
              id: "peer-id",
              hostname: "peer",
              dnsName: "peer.example.ts.net.",
              tailscaleIPs: ["100.64.0.1"],
              os: "linux",
              online: true,
              active: true,
              exitNode: false,
              exitNodeOption: false,
              isSubnetRouter: false,
              rxBytes: 0,
              txBytes: 0,
              taildropTarget: false,
              sshHost: false,
              userId: 0,
              userName: "",
              userLoginName: "",
              userProfilePicURL: "",
            },
          ],
        },
      }),
    ).toBe(true);
    expect(isValidNativeReply({ arbitrary: "object" })).toBe(false);
    expect(isValidNativeReply({})).toBe(false);
  });

  it.each([
    {
      status: {
        ...makeValidStatus(),
        peers: {},
      },
    },
    {
      status: {
        ...makeValidStatus(),
        peers: [{}],
      },
    },
    {
      pong: {},
      status: {
        ...makeValidStatus(),
        health: "not-an-array",
      },
    },
    { procRunning: { port: "1055", pid: 1 } },
    { init: { error: 42 } },
    { pong: "bad" },
    { profiles: { current: null, profiles: [] } },
    {
      fileSendProgress: {
        targetNodeID: "node",
        name: "file.txt",
      },
    },
  ])("rejects malformed recognized envelopes: %j", (reply) => {
    expect(isValidNativeReply(reply)).toBe(false);
  });
});
