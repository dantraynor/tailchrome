import type {
  NativeReply,
  TailscaleState,
  BackgroundMessage,
  PopupMessage,
} from "../shared/types";
import { KEEPALIVE_INTERVAL_MS, ADMIN_URL, TAILSCALE_SERVICE_IP } from "../shared/constants";
import { StateStore } from "./state-store";
import { NativeHostConnection } from "./native-host";
import { ProxyManager } from "./proxy-manager";
import { BadgeManager } from "./badge-manager";

// ---------------------------------------------------------------------------
// Initialize components
// ---------------------------------------------------------------------------

const store = new StateStore();
const proxyManager = new ProxyManager();
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

// ---------------------------------------------------------------------------
// Native host connection
// ---------------------------------------------------------------------------

function handleNativeMessage(msg: NativeReply): void {
  // Process running: the native host tells us which port to proxy through
  if (msg.procRunning) {
    if (msg.procRunning.error) {
      console.error(
        "[Background] procRunning error:",
        msg.procRunning.error
      );
      store.update({ error: msg.procRunning.error });
    } else {
      store.update({
        proxyPort: msg.procRunning.port,
        proxyEnabled: true,
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
      // Request initial status
      nativeHost.send({ cmd: "get-status" });
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

  // Exit node suggestion — show to user, do NOT auto-apply
  if (msg.exitNodeSuggestion) {
    for (const port of popupPorts) {
      try {
        const popupMsg: PopupMessage = {
          type: "toast",
          message: `Suggested exit node: ${msg.exitNodeSuggestion.hostname}`,
          level: "info",
        };
        port.postMessage(popupMsg);
      } catch {
        // Port may have disconnected
      }
    }
  }

  // File send progress
  if (msg.fileSendProgress) {
    for (const port of popupPorts) {
      try {
        const popupMsg: PopupMessage = {
          type: "toast",
          message: msg.fileSendProgress.done
            ? msg.fileSendProgress.error
              ? `File send failed: ${msg.fileSendProgress.error}`
              : `File "${msg.fileSendProgress.name}" sent successfully`
            : `Sending "${msg.fileSendProgress.name}": ${msg.fileSendProgress.percent}%`,
          level: msg.fileSendProgress.error ? "error" : "info",
        };
        port.postMessage(popupMsg);
      } catch {
        // Port may have disconnected
      }
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
      // Forward error to popup
      for (const port of popupPorts) {
        try {
          const popupMsg: PopupMessage = {
            type: "toast",
            message: msg.error.message,
            level: "error",
          };
          port.postMessage(popupMsg);
        } catch {
          // Port may have disconnected
        }
      }
    }
  }
}

function handleNativeStateChange(connected: boolean): void {
  if (!connected) {
    exitNodeRestoreAttempted = false;
  }
  store.update({
    hostConnected: connected,
    // Clear install error on successful connection, reset state when disconnected
    ...(connected
      ? { installError: false }
      : {
          initialized: false,
          proxyPort: null,
          proxyEnabled: false,
          backendState: "NoState" as const,
        }),
  });
}

const nativeHost = new NativeHostConnection(
  handleNativeMessage,
  handleNativeStateChange
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

chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
  if (port.name !== "popup") return;

  popupPorts.add(port);

  // If we're in install error state, retry the native host connection
  // in case the user just installed the helper
  if (store.getState().installError) {
    nativeHost.connect().catch(() => {
      // Still in install error state, popup will show needs-install
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
        nativeHost.send({ cmd: "down" });
      } else if (
        state.backendState === "Stopped" ||
        state.backendState === "NoState"
      ) {
        nativeHost.send({ cmd: "up" });
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

setInterval(() => {
  if (store.getState().hostConnected) {
    nativeHost.send({ cmd: "ping" });
  }
}, KEEPALIVE_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Proxy cleanup on extension unload
// ---------------------------------------------------------------------------

chrome.runtime.onSuspend?.addListener(() => {
  proxyManager.clear();
});

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
  const encoded = btoa(url);
  nativeHost.send({
    cmd: "send-file",
    nodeID: target.id,
    fileName,
    fileData: encoded,
    fileSize: url.length,
  });
});
