import type {
  NativeReply,
  TailscaleState,
  BackgroundMessage,
  PopupMessage,
  ProxyManager,
} from "../types";
import { KEEPALIVE_INTERVAL_MS, ADMIN_URL, TAILSCALE_SERVICE_IP, EXPECTED_HOST_VERSION } from "../constants";
import { StateStore } from "./state-store";
import { NativeHostConnection } from "./native-host";
import { BadgeManager } from "./badge-manager";
import { DefaultTimerService, type TimerService } from "./timer-service";

export type { ProxyManager };

// ---------------------------------------------------------------------------
// Return type so browser entry points can access the proxy manager
// ---------------------------------------------------------------------------

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
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

const ALLOWED_LOGIN_ORIGINS = [
  "https://login.tailscale.com",
  "https://controlplane.tailscale.com",
];

function isValidLoginURL(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_LOGIN_ORIGINS.some(
      (origin) => parsed.origin === origin
    );
  } catch {
    return false;
  }
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

export function initBackground(
  proxyManager: ProxyManager,
  nativeHostId: string,
  options?: InitBackgroundOptions,
): BackgroundHandle {
  const timerService = options?.timerService ?? new DefaultTimerService();
  const store = new StateStore();
  const badgeManager = new BadgeManager();

  // Connected popup ports
  const popupPorts: Set<chrome.runtime.Port> = new Set();

  // Track whether we've attempted to restore exit node for this connection
  let exitNodeRestoreAttempted = false;

  // ---------------------------------------------------------------------------
  // Subscribe to state changes
  // ---------------------------------------------------------------------------

  store.subscribe((state: TailscaleState) => {
    proxyManager.apply(state);
    badgeManager.update(state);
    broadcastToPopup(state);
  });

  // ---------------------------------------------------------------------------
  // Native host connection
  // ---------------------------------------------------------------------------

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
        store.update({ error: msg.procRunning.error, hostVersion, hostVersionMismatch });
      } else {
        store.update({
          proxyPort: msg.procRunning.port,
          proxyEnabled: true,
          hostVersion,
          hostVersionMismatch,
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
      store.applyStatusUpdate(msg.status);

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
    }

    // Profiles result
    if (msg.profiles) {
      store.update({
        currentProfile: msg.profiles.current,
        profiles: msg.profiles.profiles,
      });
    }

    // Exit node suggestion — store in state and show toast, do NOT auto-apply
    if (msg.exitNodeSuggestion) {
      store.update({ exitNodeSuggestion: msg.exitNodeSuggestion });
      sendToastToPopup(
        `Suggested exit node: ${msg.exitNodeSuggestion.hostname}`,
        "info",
      );
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

    // Error from native host
    if (msg.error) {
      if (msg.error.message === "install_error") {
        store.update({ installError: true, hostConnected: false });
      } else {
        console.error(
          `[Background] Native error for cmd="${msg.error.cmd}":`,
          msg.error.message
        );
        store.update({ error: msg.error.message });
        sendToastToPopup(msg.error.message, "error");
      }
    }
  }

  function handleNativeStateChange(connected: boolean): void {
    if (!connected) {
      exitNodeRestoreAttempted = false;
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

  // ---------------------------------------------------------------------------
  // Popup communication
  // ---------------------------------------------------------------------------

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

  function sendToastToPopup(message: string, level: "info" | "error", persistent = false): void {
    for (const port of popupPorts) {
      try {
        const popupMsg: PopupMessage = { type: "toast", message, level, persistent };
        port.postMessage(popupMsg);
      } catch {
        // Port may have disconnected
      }
    }
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

  // ---------------------------------------------------------------------------
  // Handle popup messages
  // ---------------------------------------------------------------------------

  function handlePopupMessage(msg: BackgroundMessage): void {
    const state = store.getState();

    switch (msg.type) {
      case "toggle": {
        if (state.backendState === "Running") {
          if (!nativeHost.send({ cmd: "down" })) {
            sendToastToPopup("Could not reach Tailscale service. Please check that the native host is installed.", "error");
          }
        } else if (
          state.backendState === "Stopped" ||
          state.backendState === "NoState"
        ) {
          if (!nativeHost.send({ cmd: "up" })) {
            sendToastToPopup("Could not reach Tailscale service. Please check that the native host is installed.", "error");
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
        if (state.browseToURL && isValidLoginURL(state.browseToURL)) {
          chrome.tabs.create({ url: state.browseToURL });
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
        nativeHost.send({ cmd: "set-exit-node", nodeID: msg.nodeID });
        chrome.storage.local.set({ lastExitNodeID: msg.nodeID });
        break;
      }

      case "clear-exit-node": {
        nativeHost.send({ cmd: "set-exit-node", nodeID: "" });
        chrome.storage.local.remove("lastExitNodeID");
        break;
      }

      case "set-pref": {
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
        });
        break;
      }

      case "suggest-exit-node": {
        nativeHost.send({ cmd: "suggest-exit-node" });
        break;
      }

      default: {
        // Exhaustiveness check: TypeScript will error if a case is missing
        const _exhaustive: never = msg;
        console.warn("[Background] Unknown popup message:", _exhaustive);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Keepalive: ping native host periodically to keep service worker alive
  // ---------------------------------------------------------------------------

  if (!options?.skipKeepalive) {
    timerService.setInterval("keepalive", () => {
      if (store.getState().hostConnected) {
        nativeHost.send({ cmd: "ping" });
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------------
  // Context menu: "Send page URL to Tailscale device"
  // ---------------------------------------------------------------------------

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
