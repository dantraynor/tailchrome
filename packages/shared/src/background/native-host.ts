import type { NativeRequest, NativeReply } from "../types";
import {
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
} from "../constants";
import { DefaultTimerService, type TimerService } from "./timer-service";

export type NativeMessageHandler = (msg: NativeReply) => void;
export type NativeStateChangeHandler = (connected: boolean) => void;

export class NativeHostConnection {
  private port: chrome.runtime.Port | null = null;
  private profileID: string | null = null;
  private reconnectDelay: number = RECONNECT_BASE_MS;
  private intentionalDisconnect = false;
  private connectedNotified = false;
  private timerService: TimerService;
  private connectPromise: Promise<void> | null = null;

  constructor(
    private nativeHostId: string,
    private onMessage: NativeMessageHandler,
    private onStateChange: NativeStateChangeHandler,
    timerService?: TimerService,
  ) {
    this.timerService = timerService ?? new DefaultTimerService();
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;

    const pending = this.performConnect().finally(() => {
      if (this.connectPromise === pending) {
        this.connectPromise = null;
      }
    });
    this.connectPromise = pending;
    return pending;
  }

  private async performConnect(): Promise<void> {
    this.intentionalDisconnect = false;

    // Cancel any pending reconnect to avoid overlapping connect calls
    this.timerService.clear("reconnect");

    this.profileID = await this.getOrCreateProfileID();

    // Clean up only after asynchronous profile hydration. connect() is
    // serialized, so another caller cannot create a second live port here.
    const previousPort = this.port;
    this.port = null;
    previousPort?.disconnect();

    const port = chrome.runtime.connectNative(this.nativeHostId);
    this.port = port;

    port.onMessage.addListener((msg: NativeReply) => {
      this.handleMessage(port, msg);
    });

    port.onDisconnect.addListener(() => {
      this.handleDisconnect(port);
    });

    // Send init message with profile ID
    port.postMessage({ cmd: "init", initID: this.profileID });
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.timerService.clear("reconnect");
    const port = this.port;
    this.port = null;
    port?.disconnect();
    this.connectedNotified = false;
    this.onStateChange(false);
  }

  send(msg: NativeRequest): boolean {
    if (!this.port) {
      console.warn("[NativeHost] Cannot send, not connected:", msg.cmd);
      return false;
    }
    try {
      this.port.postMessage(msg);
      return true;
    } catch (err) {
      console.error("[NativeHost] Send error:", err);
      return false;
    }
  }

  private handleMessage(sourcePort: chrome.runtime.Port, msg: NativeReply): void {
    if (sourcePort !== this.port) return;
    // A message from the host means the connection is healthy — reset backoff
    this.reconnectDelay = RECONNECT_BASE_MS;
    if (!this.connectedNotified) {
      this.connectedNotified = true;
      this.onStateChange(true);
    }
    this.onMessage(msg);
  }

  private handleDisconnect(disconnectedPort: chrome.runtime.Port): void {
    if (disconnectedPort !== this.port) return;
    // Chrome reports errors via chrome.runtime.lastError
    // Firefox reports errors via port.error
    const lastError = chrome.runtime.lastError;
    const portError = (disconnectedPort as unknown as { error?: { message?: string } })?.error;
    const errorMessage = lastError?.message ?? portError?.message ?? "";

    this.port = null;
    if (this.connectedNotified) {
      this.connectedNotified = false;
      this.onStateChange(false);
    }

    // Detect installation error: native host not found or not allowed
    // Chrome: "Specified native messaging host not found"
    // Firefox: "No such native application <name>"
    if (
      errorMessage.includes("not found") ||
      errorMessage.includes("Specified native messaging host not found") ||
      errorMessage.includes("No such native application") ||
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
    const delay = this.reconnectDelay;

    console.log(
      `[NativeHost] Reconnecting in ${delay}ms...`
    );

    // Apply exponential backoff for next attempt
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);

    this.timerService.setTimeout("reconnect", () => {
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
