import type {
  HelperFailure,
  NativeRequest,
  NativeReply,
} from "../types";
import {
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
} from "../constants";
import { sanitizeDiagnosticMessage } from "../helper-diagnostics";
import { DefaultTimerService, type TimerService } from "./timer-service";

export type NativeMessageHandler = (msg: NativeReply) => void;
export type NativeConnectionEvent =
  | { type: "connected" }
  | {
      type: "disconnected";
      failure: HelperFailure | null;
      reconnecting: boolean;
    }
  | {
      type: "diagnostic";
      diagnosticCode: string;
      diagnosticMessage: string | null;
    };
export type NativeConnectionEventHandler = (
  event: NativeConnectionEvent,
) => void;

export class NativeHostConnection {
  private port: chrome.runtime.Port | null = null;
  private profileID: string | null = null;
  private reconnectDelay: number = RECONNECT_BASE_MS;
  private intentionalDisconnect = false;
  private hasReceivedValidMessage = false;
  private timerService: TimerService;
  private connectPromise: Promise<void> | null = null;

  constructor(
    private nativeHostId: string,
    private onMessage: NativeMessageHandler,
    private onConnectionEvent: NativeConnectionEventHandler,
    timerService?: TimerService,
    // Resolves the wantRunning hint sent with init. The host starts a fresh
    // tsnet node with WantRunning forced on, so init must say when the node
    // should stay down (auto-connect off, or an in-session disconnect).
    // Helpers that predate this field ignore it; the background compensates
    // by sending an explicit `down` if the node comes up against the hint.
    private getWantRunning?: () => Promise<boolean | undefined>,
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

    try {
      this.profileID = await this.getOrCreateProfileID();
    } catch (err) {
      this.handleStartFailure("native-profile-initialization-failed", err);
      return;
    }

    // Clean up only after asynchronous profile hydration. connect() is
    // serialized, so another caller cannot create a second live port here.
    const previousPort = this.port;
    this.port = null;
    previousPort?.disconnect();
    this.hasReceivedValidMessage = false;

    // Resolve before opening the port so init is the first thing sent.
    let wantRunning: boolean | undefined;
    if (this.getWantRunning) {
      try {
        wantRunning = await this.getWantRunning();
      } catch (err) {
        this.emitDiagnostic("native-want-running-failed", err);
      }
    }

    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(this.nativeHostId);
    } catch (err) {
      this.handleStartFailure("native-connect-threw", err);
      return;
    }
    this.port = port;

    port.onMessage.addListener((msg: unknown) => {
      this.handleMessage(port, msg);
    });

    port.onDisconnect.addListener(() => {
      this.handleDisconnect(port);
    });

    // Send init message with profile ID
    try {
      port.postMessage({
        cmd: "init",
        initID: this.profileID,
        ...(wantRunning !== undefined ? { wantRunning } : {}),
      });
    } catch (err) {
      this.port = null;
      port.disconnect();
      this.handleStartFailure("native-init-send-failed", err);
    }
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.timerService.clear("reconnect");
    const port = this.port;
    this.port = null;
    port?.disconnect();
    this.hasReceivedValidMessage = false;
    this.onConnectionEvent({
      type: "disconnected",
      failure: null,
      reconnecting: false,
    });
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
      this.emitDiagnostic(`native-send-${msg.cmd}-failed`, err);
      return false;
    }
  }

  private handleMessage(sourcePort: chrome.runtime.Port, msg: unknown): void {
    if (sourcePort !== this.port) return;
    if (!isValidNativeReply(msg)) {
      // Unknown envelopes can contain arbitrary helper state. Keep only the
      // classification code; never serialize the payload into diagnostics.
      this.emitDiagnostic("native-message-invalid", null);
      return;
    }

    // A message from the host means the connection is healthy — reset backoff
    this.reconnectDelay = RECONNECT_BASE_MS;
    if (!this.hasReceivedValidMessage) {
      this.hasReceivedValidMessage = true;
      this.onConnectionEvent({ type: "connected" });
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

    const wasHealthy = this.hasReceivedValidMessage;
    this.port = null;
    this.hasReceivedValidMessage = false;
    if (this.intentionalDisconnect) {
      return;
    }

    const failure = classifyDisconnect(errorMessage, wasHealthy);
    const reconnecting =
      failure.kind === "helper-start-failed" ||
      failure.kind === "helper-stopped";
    this.onConnectionEvent({
      type: "disconnected",
      failure,
      reconnecting,
    });
    console.warn(`[NativeHost] Connection failed: ${failure.diagnosticCode}`);
    this.backoffAndReconnect();
  }

  private handleStartFailure(code: string, detail: unknown): void {
    const failure: HelperFailure = {
      kind: "helper-start-failed",
      diagnosticCode: code,
      diagnosticMessage: sanitizeDiagnosticMessage(detail),
    };
    this.onConnectionEvent({
      type: "disconnected",
      failure,
      reconnecting: true,
    });
    console.warn(`[NativeHost] Connection failed: ${code}`);
    this.backoffAndReconnect();
  }

  private emitDiagnostic(code: string, detail: unknown): void {
    this.onConnectionEvent({
      type: "diagnostic",
      diagnosticCode: code,
      diagnosticMessage: sanitizeDiagnosticMessage(detail),
    });
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
        this.emitDiagnostic("native-reconnect-failed", err);
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

function classifyDisconnect(
  errorMessage: string,
  wasHealthy: boolean,
): HelperFailure {
  const diagnosticMessage = sanitizeDiagnosticMessage(errorMessage);
  if (wasHealthy) {
    return {
      kind: "helper-stopped",
      diagnosticCode: "native-host-stopped",
      diagnosticMessage,
    };
  }

  const normalized = errorMessage.toLowerCase();
  if (
    /specified native messaging host .*not found/.test(normalized) ||
    /native messaging host .*not found/.test(normalized) ||
    normalized.includes("no such native application")
  ) {
    return {
      kind: "helper-unavailable",
      diagnosticCode: "native-host-unavailable",
      diagnosticMessage,
    };
  }
  if (
    /native messaging host .*forbidden/.test(normalized) ||
    /native messaging host .*not allowed/.test(normalized) ||
    normalized.includes("is forbidden") ||
    normalized.includes("not allowed")
  ) {
    return {
      kind: "helper-not-allowed",
      diagnosticCode: "native-host-not-allowed",
      diagnosticMessage,
    };
  }

  return {
    kind: "helper-start-failed",
    diagnosticCode: "native-host-start-failed",
    diagnosticMessage,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isNullableStringArray(value: unknown): boolean {
  return value === null || isStringArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function optionalField(
  record: Record<string, unknown>,
  key: string,
  predicate: (value: unknown) => boolean,
): boolean {
  return !hasOwn(record, key) || predicate(record[key]);
}

function isLocation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    optionalField(value, "city", isString) &&
    optionalField(value, "cityCode", isString) &&
    optionalField(value, "country", isString) &&
    optionalField(value, "countryCode", isString) &&
    optionalField(value, "latitude", isFiniteNumber) &&
    optionalField(value, "longitude", isFiniteNumber) &&
    optionalField(value, "priority", isFiniteNumber)
  );
}

function isNullableLocation(value: unknown): boolean {
  return value === null || isLocation(value);
}

function isSelfNode(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isString(value["id"]) &&
    isString(value["hostname"]) &&
    isString(value["dnsName"]) &&
    isNullableStringArray(value["tailscaleIPs"]) &&
    isString(value["os"]) &&
    isBoolean(value["online"]) &&
    optionalField(value, "keyExpiry", isNullableString)
  );
}

function isPeer(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isString(value["id"]) &&
    isString(value["hostname"]) &&
    isString(value["dnsName"]) &&
    isNullableStringArray(value["tailscaleIPs"]) &&
    isString(value["os"]) &&
    isBoolean(value["online"]) &&
    isBoolean(value["active"]) &&
    isBoolean(value["exitNode"]) &&
    isBoolean(value["exitNodeOption"]) &&
    isBoolean(value["isSubnetRouter"]) &&
    optionalField(value, "subnets", isNullableStringArray) &&
    optionalField(value, "tags", isNullableStringArray) &&
    isFiniteNumber(value["rxBytes"]) &&
    isFiniteNumber(value["txBytes"]) &&
    optionalField(value, "lastSeen", isNullableString) &&
    optionalField(value, "lastHandshake", isNullableString) &&
    optionalField(value, "keyExpiry", isNullableString) &&
    optionalField(value, "location", isNullableLocation) &&
    isBoolean(value["taildropTarget"]) &&
    isBoolean(value["sshHost"]) &&
    isFiniteNumber(value["userId"]) &&
    isString(value["userName"]) &&
    isString(value["userLoginName"]) &&
    isString(value["userProfilePicURL"])
  );
}

function isExitNode(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isString(value["id"]) &&
    isString(value["hostname"]) &&
    isString(value["dnsName"]) &&
    optionalField(value, "location", isNullableLocation) &&
    isBoolean(value["online"])
  );
}

function isPrefs(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    optionalField(value, "exitNodeID", isString) &&
    isBoolean(value["exitNodeAllowLANAccess"]) &&
    isBoolean(value["corpDNS"]) &&
    isBoolean(value["shieldsUp"]) &&
    optionalField(value, "advertiseExitNode", isBoolean) &&
    optionalField(value, "runSSH", isBoolean) &&
    optionalField(value, "advertiseRoutes", isNullableStringArray) &&
    optionalField(value, "controlURL", isString)
  );
}

function isStatus(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const backendStates = new Set([
    "NoState",
    "NeedsMachineAuth",
    "NeedsLogin",
    "InUseOtherUser",
    "Stopped",
    "Starting",
    "Running",
  ]);
  return (
    isString(value["backendState"]) &&
    backendStates.has(value["backendState"]) &&
    isBoolean(value["running"]) &&
    isNullableString(value["tailnet"]) &&
    isString(value["magicDNSSuffix"]) &&
    optionalField(
      value,
      "selfNode",
      (field) => field === null || isSelfNode(field),
    ) &&
    isBoolean(value["needsLogin"]) &&
    optionalField(value, "browseToURL", isString) &&
    optionalField(value, "authURL", isString) &&
    optionalField(
      value,
      "exitNode",
      (field) => field === null || isExitNode(field),
    ) &&
    hasOwn(value, "peers") &&
    (value["peers"] === null ||
      (Array.isArray(value["peers"]) && value["peers"].every(isPeer))) &&
    optionalField(
      value,
      "prefs",
      (field) => field === null || isPrefs(field),
    ) &&
    hasOwn(value, "health") &&
    isNullableStringArray(value["health"]) &&
    optionalField(value, "error", isNullableString) &&
    optionalField(value, "peersTruncated", isBoolean) &&
    optionalField(value, "totalPeers", isFiniteNumber)
  );
}

function isProfile(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value["id"]) &&
    isString(value["name"])
  );
}

function isProcRunning(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value["port"]) &&
    isFiniteNumber(value["pid"]) &&
    optionalField(value, "version", isString) &&
    optionalField(value, "error", isString) &&
    optionalField(value, "supportsNetcheck", isBoolean) &&
    optionalField(value, "supportsPingPeer", isBoolean) &&
    optionalField(value, "supportsLogin", isBoolean) &&
    optionalField(value, "supportsCustomControlURL", isBoolean)
  );
}

function isInit(value: unknown): boolean {
  return isRecord(value) && optionalField(value, "error", isString);
}

function isPong(value: unknown): boolean {
  return isRecord(value);
}

function isProfiles(value: unknown): boolean {
  return (
    isRecord(value) &&
    isProfile(value["current"]) &&
    Array.isArray(value["profiles"]) &&
    value["profiles"].every(isProfile)
  );
}

function isExitNodeSuggestion(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value["id"]) &&
    isString(value["hostname"]) &&
    optionalField(value, "location", isNullableLocation)
  );
}

function isFileSendProgress(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value["targetNodeID"]) &&
    isString(value["name"]) &&
    isFiniteNumber(value["percent"]) &&
    isBoolean(value["done"]) &&
    optionalField(value, "error", isNullableString)
  );
}

function isDiagnostic(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value["title"]) &&
    isString(value["body"])
  );
}

function isNativeError(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value["cmd"]) &&
    isString(value["message"])
  );
}

/**
 * A port is healthy only after a recognized reply field has the expected
 * shape. Empty, arbitrary, and partially malformed envelopes remain
 * diagnostics only.
 */
export function isValidNativeReply(value: unknown): value is NativeReply {
  if (!isRecord(value)) return false;
  const validators: Array<[string, (field: unknown) => boolean]> = [
    ["procRunning", isProcRunning],
    ["init", isInit],
    ["pong", isPong],
    ["status", isStatus],
    ["profiles", isProfiles],
    ["exitNodeSuggestion", isExitNodeSuggestion],
    ["fileSendProgress", isFileSendProgress],
    ["diagnostic", isDiagnostic],
    ["error", isNativeError],
  ];
  let recognized = false;
  for (const [key, validator] of validators) {
    if (!hasOwn(value, key)) continue;
    recognized = true;
    if (!validator(value[key])) return false;
  }
  return recognized;
}
