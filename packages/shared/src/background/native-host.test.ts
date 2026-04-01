import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NativeHostConnection } from "./native-host";

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

describe("NativeHostConnection", () => {
  let connectNativeSpy: ReturnType<typeof vi.fn>;
  let storageGetSpy: ReturnType<typeof vi.fn>;
  let storageSetSpy: ReturnType<typeof vi.fn>;
  let mockPort: ReturnType<typeof createMockPort>;
  let onMessage: ReturnType<typeof vi.fn>;
  let onStateChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockPort = createMockPort();
    connectNativeSpy = vi.fn().mockReturnValue(mockPort.port);
    storageGetSpy = vi.fn().mockResolvedValue({ profileId: "test-profile-id" });
    storageSetSpy = vi.fn().mockResolvedValue(undefined);

    chrome.runtime.connectNative = connectNativeSpy as unknown as typeof chrome.runtime.connectNative;
    chrome.storage.local.get = storageGetSpy;
    chrome.storage.local.set = storageSetSpy;
    chrome.runtime.lastError = undefined;

    onMessage = vi.fn();
    onStateChange = vi.fn();
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
  });

  describe("message handling", () => {
    it("notifies state change on first message received", async () => {
      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      // Simulate a message from native host
      mockPort.messageListeners[0]!({ pong: {} });

      expect(onStateChange).toHaveBeenCalledWith(true);
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

      const statusMsg = { status: { backendState: "Running" } };
      mockPort.messageListeners[0]!(statusMsg);

      expect(onMessage).toHaveBeenCalledWith(statusMsg);
    });
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
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      mockPort.port.postMessage.mockImplementation(() => {
        throw new Error("port closed");
      });

      // Should not throw
      conn.send({ cmd: "ping" });
      expect(errorSpy).toHaveBeenCalledWith("[NativeHost] Send error:", expect.any(Error));
      errorSpy.mockRestore();
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
      expect(onStateChange).toHaveBeenCalledWith(false);
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

    it("detects install error from 'not found' message", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});

      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      // Simulate disconnect with "not found" error
      chrome.runtime.lastError = {
        message: "Specified native messaging host not found",
      };
      mockPort.disconnectListeners[0]!(mockPort.port);

      expect(onMessage).toHaveBeenCalledWith({
        error: { cmd: "connect", message: "install_error" },
      });

      chrome.runtime.lastError = undefined;
      vi.restoreAllMocks();
    });

    it("detects install error from Firefox 'No such native application'", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});

      const conn = new NativeHostConnection("com.tailscale.test", onMessage, onStateChange);
      await conn.connect();

      // Firefox-style error via port.error
      chrome.runtime.lastError = undefined;
      const portWithError = {
        ...mockPort.port,
        error: { message: "No such native application com.tailscale.test" },
      };
      mockPort.disconnectListeners[0]!(portWithError);

      expect(onMessage).toHaveBeenCalledWith({
        error: { cmd: "connect", message: "install_error" },
      });

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
