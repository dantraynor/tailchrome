import type { NativeRequest, NativeReply } from "../shared/types";
import {
  NATIVE_HOST_ID,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
} from "../shared/constants";

export type NativeMessageHandler = (msg: NativeReply) => void;
export type NativeStateChangeHandler = (connected: boolean) => void;

export class NativeHostConnection {
  private port: chrome.runtime.Port | null = null;
  private profileID: string | null = null;
  private reconnectDelay: number = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;
  private connectedNotified = false;

  constructor(
    private onMessage: NativeMessageHandler,
    private onStateChange: NativeStateChangeHandler
  ) {}

  async connect(): Promise<void> {
    this.intentionalDisconnect = false;

    // Cancel any pending reconnect to avoid overlapping connect calls
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Clean up any existing port
    if (this.port) {
      this.port.disconnect();
      this.port = null;
    }

    this.profileID = await this.getOrCreateProfileID();

    this.port = chrome.runtime.connectNative(NATIVE_HOST_ID);

    this.port.onMessage.addListener((msg: NativeReply) => {
      this.handleMessage(msg);
    });

    this.port.onDisconnect.addListener(() => {
      this.handleDisconnect();
    });

    // Send init message with profile ID
    this.send({ cmd: "init", initID: this.profileID });
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.port) {
      this.port.disconnect();
      this.port = null;
    }
    this.connectedNotified = false;
    this.onStateChange(false);
  }

  send(msg: NativeRequest): void {
    if (!this.port) {
      console.warn("[NativeHost] Cannot send, not connected:", msg.cmd);
      return;
    }
    try {
      this.port.postMessage(msg);
    } catch (err) {
      console.error("[NativeHost] Send error:", err);
    }
  }

  private handleMessage(msg: NativeReply): void {
    // A message from the host means the connection is healthy — reset backoff
    this.reconnectDelay = RECONNECT_BASE_MS;
    if (!this.connectedNotified) {
      this.connectedNotified = true;
      this.onStateChange(true);
    }
    this.onMessage(msg);
  }

  private handleDisconnect(): void {
    const lastError = chrome.runtime.lastError;
    const errorMessage = lastError?.message ?? "";

    this.port = null;
    if (this.connectedNotified) {
      this.connectedNotified = false;
      this.onStateChange(false);
    }

    // Detect installation error: native host not found or not allowed
    if (
      errorMessage.includes("not found") ||
      errorMessage.includes("Specified native messaging host not found") ||
      errorMessage.includes("forbidden") ||
      errorMessage.includes("is forbidden")
    ) {
      console.error(
        "[NativeHost] Native host not found. Is the native messaging host installed?",
        errorMessage
      );
      // Signal install error via a special message
      this.onMessage({ error: { cmd: "connect", message: "install_error" } });
      // Still schedule reconnect so we pick up the helper once installed
      this.backoffAndReconnect();
      return;
    }

    if (this.intentionalDisconnect) {
      return;
    }

    console.warn(
      "[NativeHost] Disconnected unexpectedly:",
      errorMessage || "unknown reason"
    );
    this.backoffAndReconnect();
  }

  private backoffAndReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }

    console.log(
      `[NativeHost] Reconnecting in ${this.reconnectDelay}ms...`
    );

    const delay = this.reconnectDelay;
    // Apply exponential backoff for next attempt
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        console.error("[NativeHost] Reconnect failed:", err);
        this.backoffAndReconnect();
      });
    }, delay);
  }

  private async getOrCreateProfileID(): Promise<string> {
    const result = await chrome.storage.local.get("profileId");
    if (result["profileId"] && typeof result["profileId"] === "string") {
      return result["profileId"];
    }

    const newID = crypto.randomUUID();
    await chrome.storage.local.set({ profileId: newID });
    return newID;
  }
}
