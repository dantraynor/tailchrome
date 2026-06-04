import type {
  NativeReply,
  TailscaleState,
  BackgroundMessage,
  PopupMessage,
  ProxyManager,
} from "../types";
import {
  KEEPALIVE_INTERVAL_MS,
  ADMIN_URL,
  TAILSCALE_SERVICE_IP,
  EXPECTED_HOST_VERSION,
  DEFAULT_LOGIN_ORIGINS,
  isCustomControlURL,
  isValidControlURL,
} from "../constants";
import { StateStore } from "./state-store";
import { NativeHostConnection } from "./native-host";
import { BadgeManager } from "./badge-manager";
import { DefaultTimerService, type TimerService } from "./timer-service";
import { applyUiSurface, readUiSurface, type BrowserKind } from "./ui-surface";
import {
  isAutoConnectHandled,
  markAutoConnectHandled,
  readAutoConnectPref,
  shouldAutoConnect,
  writeAutoConnectPref,
} from "./auto-connect";
import {
  DOMAIN_SPLIT_STORAGE_KEY,
  normalizeDomainSplit,
  readDomainSplit,
  writeDomainSplit,
} from "./domain-split";

export type { ProxyManager };

export interface BackgroundHandle {
  proxyManager: ProxyManager;
  /** Send a keepalive ping if the host is connected. */
  sendKeepalive(): void;
  /** Reconnect to the native host. */
  reconnect(): Promise<void>;
}

export interface InitBackgroundOptions {
  /** Custom timer implementation (e.g. for reconnect backoff). Defaults to setTimeout/setInterval. */
  timerService?: TimerService;
  /** Skip the built-in setInterval keepalive (e.g. when the caller uses browser.alarms instead). */
  skipKeepalive?: boolean;
  browserKind?: BrowserKind;
}

const LOGIN_OPEN_TIMEOUT_MS = 30_000;
const LOGIN_OPEN_TIMEOUT_NAME = "login-open-timeout";

/**
 * Returns true if `url` is a login URL we'll open in a tab. Always accepts the
 * Tailscale-managed origins when using the default coordination server. For
 * custom coordination servers, allow delegated HTTPS auth URLs while rejecting
 * stale Tailscale-managed login URLs from a previous default-server status.
 */
export function isValidLoginURL(url: string, controlURL?: string | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (isCustomControlURL(controlURL)) {
    if (DEFAULT_LOGIN_ORIGINS.includes(parsed.origin)) return false;
    if (parsed.protocol === "https:") return true;
    try {
      const controlProtocol = new URL(controlURL!).protocol;
      return controlProtocol === "http:" && parsed.protocol === "http:";
    } catch {
      return false;
    }
  }
  if (DEFAULT_LOGIN_ORIGINS.includes(parsed.origin)) return true;
  return false;
}

/**
 * True only for a login URL served from a Tailscale-default origin — the
 * stale-linger case worth waiting out after switching to a custom server. A
 * malformed or custom-origin-but-invalid URL is NOT stale; it should surface an
 * error rather than spin until the pending-login timeout.
 */
function isDefaultOriginLoginURL(url: string): boolean {
  try {
    return DEFAULT_LOGIN_ORIGINS.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

function loginURLFromStatus(status: NativeReply["status"]): string | null {
  if (!status) return null;
  return status.browseToURL || status.authURL || null;
}

/**
 * Coarse, origin-level check for whether saving `next` actually changes the
 * coordination server vs the currently-cached `current`. Used only to decide
 * when to drop switch-scoped cached state; the native host stays the authority
 * on the real change. All default-server synonyms collapse to the same key.
 */
function controlServerChanged(
  next: string,
  current: string | undefined | null,
): boolean {
  const key = (url: string | undefined | null): string => {
    if (!url || !isCustomControlURL(url)) return "";
    try {
      // Mirror the host's `controlURLCompareKey`: lowercase scheme+host but
      // keep the (case-sensitive) path and query, so a same-origin switch that
      // only changes the path still counts as a real server change. Drop a bare
      // "/" path and the fragment, matching the host's normalization.
      const u = new URL(url);
      u.hash = "";
      if (u.pathname === "/" && u.search === "") u.pathname = "";
      return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname}${u.search}`;
    } catch {
      return url.trim().toLowerCase();
    }
  };
  return key(next) !== key(current);
}

/**
 * Returns true if the host version's major.minor doesn't match the expected version.
 * Patch differences are tolerated. Missing or unparseable versions are treated as a mismatch.
 */
function isVersionMismatch(hostVersion: string | null): boolean {
  if (!hostVersion) return true;
  // Strip leading "v" if present
  const host = hostVersion.replace(/^v/, "");
  const expected = EXPECTED_HOST_VERSION.replace(/^v/, "");
  const hostParts = host.split(".");
  const expectedParts = expected.split(".");
  if (hostParts.length < 2 || expectedParts.length < 2) return true;
  return hostParts[0] !== expectedParts[0] || hostParts[1] !== expectedParts[1];
}

const NATIVE_HOST_UNREACHABLE =
  "Could not reach Tailscale service. Please check that the native host is installed.";

function domainSplitEquals(
  a: { mode: string; domains: string[] },
  b: { mode: string; domains: string[] },
): boolean {
  if (a.mode !== b.mode) return false;
  if (a.domains.length !== b.domains.length) return false;
  for (let i = 0; i < a.domains.length; i++) {
    if (a.domains[i] !== b.domains[i]) return false;
  }
  return true;
}

export function initBackground(
  proxyManager: ProxyManager,
  nativeHostId: string,
  options?: InitBackgroundOptions,
): BackgroundHandle {
  const timerService = options?.timerService ?? new DefaultTimerService();
  const browserKind: BrowserKind = options?.browserKind ?? "chrome";

  // Apply the persisted UI-surface preference and react to changes.
  // Catch rejections so the service worker startup never fails on a
  // missing-API edge case (older Chrome, Firefox without the polyfill, etc.).
  const logUiSurfaceFailure = (err: unknown): void => {
    console.warn("[Background] applyUiSurface failed:", err);
  };
  void readUiSurface()
    .then((surface) => applyUiSurface(surface, browserKind))
    .catch(logUiSurfaceFailure);

  const store = new StateStore();

  void readDomainSplit()
    .then((config) => {
      if (!domainSplitEquals(store.getState().domainSplit, config)) {
        store.update({ domainSplit: config });
      }
    })
    .catch((err) => {
      console.warn("[Background] readDomainSplit failed:", err);
    });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("uiSurface" in changes) {
      const next = changes["uiSurface"]?.newValue;
      if (next === "popup" || next === "sidePanel") {
        void applyUiSurface(next, browserKind).catch(logUiSurfaceFailure);
      }
    }
    if (DOMAIN_SPLIT_STORAGE_KEY in changes) {
      const next = normalizeDomainSplit(
        changes[DOMAIN_SPLIT_STORAGE_KEY]?.newValue,
      );
      const current = store.getState().domainSplit;
      if (!domainSplitEquals(current, next)) {
        store.update({ domainSplit: next });
      }
    }
  });
  const badgeManager = new BadgeManager();

  // Connected popup ports
  const popupPorts: Set<chrome.runtime.Port> = new Set();

  // Track whether we've attempted to restore exit node for this connection
  let exitNodeRestoreAttempted = false;
  let latestBackendState: TailscaleState["backendState"] | null = null;
  // Last coordination server the host has actually confirmed. Used to drop
  // switch-scoped persistent state (the saved exit node) only once the server
  // change is committed — never optimistically, since the host can roll a
  // switch back. `undefined` means no status has established a baseline yet.
  let lastConfirmedControlURL: string | undefined;

  // Hydrate the auto-connect preference so the popup reflects it on first
  // render. If the first native status arrived before storage resolved, re-run
  // the auto-connect decision against that real status rather than the default.
  void readAutoConnectPref()
    .then((value) => {
      store.update({ autoConnectOnStart: value });
      if (value && latestBackendState !== null) {
        maybeAutoConnect(latestBackendState);
      }
    })
    .catch((err) => {
      console.warn("[Background] readAutoConnectPref failed:", err);
    });
  let pendingLoginOpen = false;

  function clearPendingLoginOpen(): void {
    pendingLoginOpen = false;
    timerService.clear(LOGIN_OPEN_TIMEOUT_NAME);
  }

  function startPendingLoginOpen(): void {
    pendingLoginOpen = true;
    timerService.setTimeout(
      LOGIN_OPEN_TIMEOUT_NAME,
      () => {
        if (!pendingLoginOpen) return;
        pendingLoginOpen = false;
        sendToastToPopup(
          "Still waiting for a Tailscale login URL. Please try again.",
          "error",
        );
      },
      LOGIN_OPEN_TIMEOUT_MS,
    );
  }

  store.subscribe((state: TailscaleState) => {
    proxyManager.apply(state);
    badgeManager.update(state);
    broadcastToPopup(state);
  });

  function handleNativeMessage(msg: NativeReply): void {
    // Process running: the native host tells us which port to proxy through
    if (msg.procRunning) {
      const hostVersion = msg.procRunning.version ?? null;
      const hostVersionMismatch = isVersionMismatch(hostVersion);

      if (msg.procRunning.error) {
        console.error(
          "[Background] procRunning error:",
          msg.procRunning.error
        );
        store.update({
          error: msg.procRunning.error,
          hostVersion,
          hostVersionMismatch,
          supportsNetcheck: false,
          supportsPingPeer: false,
          supportsLogin: false,
          supportsCustomControlURL: false,
        });
      } else {
        store.update({
          proxyPort: msg.procRunning.port,
          proxyEnabled: true,
          hostVersion,
          hostVersionMismatch,
          supportsNetcheck: msg.procRunning.supportsNetcheck === true,
          supportsPingPeer: msg.procRunning.supportsPingPeer === true,
          supportsLogin: msg.procRunning.supportsLogin === true,
          supportsCustomControlURL: msg.procRunning.supportsCustomControlURL === true,
        });
      }
    }

    // Init acknowledgement
    if (msg.init) {
      if (msg.init.error) {
        console.error("[Background] Init error:", msg.init.error);
        store.update({ error: msg.init.error });
      } else {
        store.update({ initialized: true });
        // Request initial status and profile list
        nativeHost.send({ cmd: "get-status" });
        nativeHost.send({ cmd: "list-profiles" });
      }
    }

    // Pong: no-op, just keeps service worker alive
    if (msg.pong) {
      // Keepalive acknowledged
    }

    // Status update
    if (msg.status) {
      latestBackendState = msg.status.backendState;
      store.applyStatusUpdate(msg.status);

      // Drop the saved exit node once the host confirms a real coordination
      // server change (a node from the old tailnet won't exist on the new one).
      // Reacting to the confirmed prefs — rather than the optimistic set-pref
      // request — means a host that rolls the switch back keeps the saved node.
      const confirmedControlURL = msg.status.prefs?.controlURL ?? "";
      if (lastConfirmedControlURL === undefined) {
        lastConfirmedControlURL = confirmedControlURL;
      } else if (
        controlServerChanged(confirmedControlURL, lastConfirmedControlURL)
      ) {
        lastConfirmedControlURL = confirmedControlURL;
        void chrome.storage.local.remove("lastExitNodeID");
      }

      const loginURL = loginURLFromStatus(msg.status);
      if (pendingLoginOpen) {
        const allowedControlURL = msg.status.prefs?.controlURL ?? null;
        if (loginURL && isValidLoginURL(loginURL, allowedControlURL)) {
          clearPendingLoginOpen();
          chrome.tabs.create({ url: loginURL });
        } else if (
          loginURL &&
          isCustomControlURL(allowedControlURL) &&
          isDefaultOriginLoginURL(loginURL)
        ) {
          // A stale Tailscale-default login URL can briefly linger right after
          // switching to a custom server. Stay pending and wait for the fresh
          // URL the host is about to emit rather than giving up; the pending
          // timeout bounds the wait. Only a default-origin URL is treated as
          // stale — a genuinely-invalid custom URL falls through to the error
          // below instead of spinning silently.
        } else if (loginURL) {
          clearPendingLoginOpen();
          sendToastToPopup(
            "Could not open the login URL Tailscale returned.",
            "error",
          );
        } else if (msg.status.backendState === "Running") {
          clearPendingLoginOpen();
        }
      }

      // Restore saved exit node after reconnection
      if (
        !exitNodeRestoreAttempted &&
        msg.status.backendState === "Running" &&
        !msg.status.exitNode
      ) {
        exitNodeRestoreAttempted = true;
        chrome.storage.local.get("lastExitNodeID").then((result) => {
          if (result["lastExitNodeID"]) {
            console.log(
              "[Background] Restoring saved exit node:",
              result["lastExitNodeID"]
            );
            nativeHost.send({
              cmd: "set-exit-node",
              nodeID: result["lastExitNodeID"],
            });
          }
        });
      } else if (msg.status.backendState === "Running" && msg.status.exitNode) {
        // Mark as attempted if already has an exit node
        exitNodeRestoreAttempted = true;
      }

      maybeAutoConnect(msg.status.backendState);
    }

    // Profiles result
    if (msg.profiles) {
      store.update({
        currentProfile: msg.profiles.current,
        profiles: msg.profiles.profiles,
      });
    }

    // Exit node suggestion — store in state, do NOT auto-apply.
    // The popup picker surfaces this in a "Recommended" row; no toast needed.
    if (msg.exitNodeSuggestion) {
      store.update({ exitNodeSuggestion: msg.exitNodeSuggestion });
    }

    // File send progress
    if (msg.fileSendProgress) {
      if (msg.fileSendProgress.done) {
        const message = msg.fileSendProgress.error
          ? `File send failed: ${msg.fileSendProgress.error}`
          : `File "${msg.fileSendProgress.name}" sent successfully`;
        sendToastToPopup(message, msg.fileSendProgress.error ? "error" : "info");
      } else {
        // In-progress: use persistent toast so it stays visible
        sendToastToPopup(
          `Sending "${msg.fileSendProgress.name}": ${msg.fileSendProgress.percent}%`,
          "info",
          true,
        );
      }
    }

    if (msg.diagnostic) {
      const body = msg.diagnostic.body.replace(/\n/g, " · ");
      const text = `${msg.diagnostic.title}: ${body}`;
      // Ping/netcheck diagnostics: ephemeral, longer read time than default toasts.
      sendToastToPopup(text, "info", false, 7000);
    }

    // Error from native host
    if (msg.error) {
      if (msg.error.message === "install_error") {
        store.update({ installError: true, hostConnected: false });
      } else if (msg.error.cmd === "suggest-exit-node") {
        // Recommendation is a passive feature: log the failure but don't
        // pollute the popup with a toast or set a sticky error.
        //
        // Do not clear `exitNodeSuggestion` here: suggest-exit-node replies
        // are not correlated to a specific request in this code path, so a
        // late error from an older request could otherwise erase a newer
        // successful recommendation.
        console.warn(
          `[Background] suggest-exit-node failed:`,
          msg.error.message
        );
      } else {
        console.error(
          `[Background] Native error for cmd="${msg.error.cmd}":`,
          msg.error.message
        );
        if (msg.error.cmd === "login") {
          clearPendingLoginOpen();
        }
        store.update({
          error: msg.error.message,
          ...(msg.error.cmd === "set-exit-node"
            ? { pendingExitNodeID: null }
            : {}),
        });
        sendToastToPopup(msg.error.message, "error");
      }
    }
  }

  function handleNativeStateChange(connected: boolean): void {
    if (!connected) {
      exitNodeRestoreAttempted = false;
      clearPendingLoginOpen();
    }
    store.update({
      hostConnected: connected,
      reconnecting: !connected && !store.getState().installError,
      // Clear install error on successful connection, reset state when disconnected
      ...(connected
        ? { installError: false }
        : {
            initialized: false,
            proxyPort: null,
            proxyEnabled: false,
            backendState: "NoState" as const,
            hostVersion: null,
            hostVersionMismatch: false,
            supportsNetcheck: false,
            supportsPingPeer: false,
            supportsLogin: false,
            supportsCustomControlURL: false,
          }),
    });
  }

  const nativeHost = new NativeHostConnection(
    nativeHostId,
    handleNativeMessage,
    handleNativeStateChange,
    timerService,
  );

  // Start the connection
  nativeHost.connect().catch((err) => {
    console.error("[Background] Initial connection failed:", err);
  });

  function broadcastToPopup(state: TailscaleState): void {
    const msg: PopupMessage = { type: "state", state };
    for (const port of popupPorts) {
      try {
        port.postMessage(msg);
      } catch {
        popupPorts.delete(port);
      }
    }
  }

  function sendToastToPopup(
    message: string,
    level: "info" | "error",
    persistent = false,
    dismissMs?: number,
    multiline = false,
  ): void {
    for (const port of popupPorts) {
      try {
        const popupMsg: PopupMessage = {
          type: "toast",
          message,
          level,
          persistent,
          ...(dismissMs != null ? { dismissMs } : {}),
          ...(multiline ? { multiline: true } : {}),
        };
        port.postMessage(popupMsg);
      } catch {
        // Port may have disconnected
      }
    }
  }

  // Fire `up` once per browser session when the pref is enabled and the node
  // is in a state we can act on. The session flag (set by markAutoConnectHandled)
  // ensures an explicit manual disconnect within the same browser session is
  // respected even when the service worker cycles.
  function maybeAutoConnect(backendState: TailscaleState["backendState"]): void {
    if (!store.getState().autoConnectOnStart) return;
    if (!shouldAutoConnect(backendState)) return;
    void isAutoConnectHandled()
      .then((handled) => {
        if (handled) return;
        return markAutoConnectHandled().then(() => {
          if (!nativeHost.send({ cmd: "up" })) {
            sendToastToPopup(NATIVE_HOST_UNREACHABLE, "error");
          }
        });
      })
      .catch((err) => {
        console.warn("[Background] auto-connect failed:", err);
      });
  }

  chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
    if (port.name !== "popup") return;

    popupPorts.add(port);

    // If we're in install error or version mismatch state, retry the native
    // host connection in case the user just installed or updated the helper
    const currentState = store.getState();
    if (currentState.installError || currentState.hostVersionMismatch) {
      nativeHost.connect().catch(() => {
        // Still in error state, popup will show needs-install or needs-update
      });
    }

    // Immediately send current state to the newly connected popup
    const stateMsg: PopupMessage = {
      type: "state",
      state: store.getState(),
    };
    try {
      port.postMessage(stateMsg);
    } catch {
      popupPorts.delete(port);
      return;
    }

    port.onMessage.addListener((msg: BackgroundMessage) => {
      handlePopupMessage(msg);
    });

    port.onDisconnect.addListener(() => {
      popupPorts.delete(port);
    });
  });

  function handlePopupMessage(msg: BackgroundMessage): void {
    const state = store.getState();

    switch (msg.type) {
      case "toggle": {
        if (state.backendState === "Running") {
          // Treat manual disconnect as an explicit decision so a later SW
          // restart doesn't trip auto-connect and undo it within the session.
          void markAutoConnectHandled().catch((err) => {
            console.warn("[Background] markAutoConnectHandled failed:", err);
          });
          if (!nativeHost.send({ cmd: "down" })) {
            sendToastToPopup(NATIVE_HOST_UNREACHABLE, "error");
          }
        } else if (
          state.backendState === "Stopped" ||
          state.backendState === "NoState"
        ) {
          if (!nativeHost.send({ cmd: "up" })) {
            sendToastToPopup(NATIVE_HOST_UNREACHABLE, "error");
          }
        } else if (state.backendState === "Starting") {
          sendToastToPopup("Tailscale is starting up\u2026", "info");
        } else if (state.backendState === "NeedsLogin") {
          sendToastToPopup("Please log in to Tailscale first.", "info");
        } else if (state.backendState === "NeedsMachineAuth") {
          sendToastToPopup("This machine needs admin approval to join the tailnet.", "error");
        } else if (state.backendState === "InUseOtherUser") {
          sendToastToPopup("Tailscale is in use by another user on this machine.", "error");
        }
        break;
      }

      case "login": {
        if (pendingLoginOpen) {
          sendToastToPopup("Still waiting for Tailscale to return a login URL.", "info");
          break;
        }
        if (
          state.browseToURL &&
          isValidLoginURL(state.browseToURL, state.prefs?.controlURL ?? null)
        ) {
          chrome.tabs.create({ url: state.browseToURL });
        } else if (!state.supportsLogin) {
          sendToastToPopup(
            "Please update the native helper to request a fresh Tailscale login URL.",
            "error",
          );
        } else if (!nativeHost.send({ cmd: "login" })) {
          clearPendingLoginOpen();
          sendToastToPopup(
            "Could not request a Tailscale login URL. Please check that the native host is installed.",
            "error",
          );
        } else {
          startPendingLoginOpen();
        }
        break;
      }

      case "logout": {
        nativeHost.send({ cmd: "logout" });
        break;
      }

      case "open-admin": {
        chrome.tabs.create({ url: ADMIN_URL });
        break;
      }

      case "open-web-client": {
        chrome.tabs.create({ url: `http://${TAILSCALE_SERVICE_IP}` });
        break;
      }

      case "set-exit-node": {
        store.update({ pendingExitNodeID: msg.nodeID });
        nativeHost.send({ cmd: "set-exit-node", nodeID: msg.nodeID });
        chrome.storage.local.set({ lastExitNodeID: msg.nodeID });
        break;
      }

      case "clear-exit-node": {
        store.update({ pendingExitNodeID: "" });
        nativeHost.send({ cmd: "set-exit-node", nodeID: "" });
        chrome.storage.local.remove("lastExitNodeID");
        break;
      }

      case "set-pref": {
        if (msg.key === "controlURL") {
          // Reverting to the default server ("") is always allowed; only
          // switching to a custom server requires native-helper support.
          if (!state.supportsCustomControlURL && msg.value !== "") {
            sendToastToPopup(
              "Please update the native helper to change the coordination server.",
              "error",
            );
            break;
          }
          // Validate at the trust boundary, not only on the popup's Save button.
          if (msg.value !== "" && !isValidControlURL(msg.value)) {
            sendToastToPopup(
              "Enter a valid coordination server URL (http:// or https://).",
              "error",
            );
            break;
          }
          // Switching coordination servers invalidates the cached login URL
          // (stale until the host replies), so drop it now for an immediate Log
          // In. The saved exit-node ID is dropped reactively once the host
          // *confirms* the change (see the status handler) rather than here, so
          // a rolled-back switch doesn't permanently lose it.
          if (controlServerChanged(msg.value, state.prefs?.controlURL)) {
            store.update({ browseToURL: "" });
          }
        }
        nativeHost.send({
          cmd: "set-prefs",
          prefs: { [msg.key]: msg.value },
        });
        break;
      }

      case "switch-profile": {
        nativeHost.send({ cmd: "switch-profile", profileID: msg.profileID });
        break;
      }

      case "new-profile": {
        nativeHost.send({ cmd: "new-profile" });
        break;
      }

      case "delete-profile": {
        nativeHost.send({
          cmd: "delete-profile",
          profileID: msg.profileID,
        });
        break;
      }

      case "send-file": {
        nativeHost.send({
          cmd: "send-file",
          nodeID: msg.targetNodeID,
          fileName: msg.name,
          fileData: msg.dataBase64,
          fileSize: msg.size,
          ...(msg.transferID !== undefined
            ? {
                transferID: msg.transferID,
                chunkIndex: msg.chunkIndex,
                chunkCount: msg.chunkCount,
              }
            : {}),
        });
        break;
      }

      case "suggest-exit-node": {
        nativeHost.send({ cmd: "suggest-exit-node" });
        break;
      }

      case "ping-peer": {
        nativeHost.send({ cmd: "ping-peer", nodeID: msg.nodeID });
        break;
      }

      case "netcheck": {
        nativeHost.send({ cmd: "netcheck" });
        break;
      }

      case "set-advertise-routes": {
        nativeHost.send({ cmd: "set-prefs", prefs: { advertiseRoutes: msg.routes } });
        break;
      }

      case "set-auto-connect-on-start": {
        store.update({ autoConnectOnStart: msg.value });
        void writeAutoConnectPref(msg.value).catch((err) => {
          console.warn("[Background] writeAutoConnectPref failed:", err);
        });
        break;
      }

      case "set-domain-split": {
        const next = normalizeDomainSplit(msg.config);
        store.update({ domainSplit: next });
        void writeDomainSplit(next).catch((err) => {
          console.warn("[Background] writeDomainSplit failed:", err);
        });
        break;
      }

      default: {
        // Exhaustiveness check: TypeScript will error if a case is missing
        const _exhaustive: never = msg;
        console.warn("[Background] Unknown popup message:", _exhaustive);
      }
    }
  }

  if (!options?.skipKeepalive) {
    timerService.setInterval("keepalive", () => {
      if (store.getState().hostConnected) {
        nativeHost.send({ cmd: "ping" });
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  chrome.runtime.onInstalled?.addListener(() => {
    chrome.contextMenus.create({
      id: "tailscale-send-page",
      title: "Send page URL to Tailscale device",
      contexts: ["page"],
    });
  });

  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId !== "tailscale-send-page") return;

    const state = store.getState();
    if (state.backendState !== "Running") return;

    const url = info.pageUrl;
    if (!url) return;

    // Find the first online peer that supports Taildrop
    const targets = state.peers.filter((p) => p.online && p.taildropTarget);
    if (targets.length === 0) return;

    // Send the URL as a text file to the first available peer
    const target = targets[0]!;
    const fileName = "shared-url.txt";
    const encoded = btoa(unescape(encodeURIComponent(url)));
    nativeHost.send({
      cmd: "send-file",
      nodeID: target.id,
      fileName,
      fileData: encoded,
      fileSize: new TextEncoder().encode(url).byteLength,
    });
  });

  return {
    proxyManager,
    sendKeepalive() {
      if (store.getState().hostConnected) {
        nativeHost.send({ cmd: "ping" });
      }
    },
    reconnect() {
      return nativeHost.connect();
    },
  };
}
