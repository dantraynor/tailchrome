import type { TailscaleState, PopupMessage, BackgroundMessage } from "../types";
import { renderConnected } from "./views/connected";
import { renderDisconnected } from "./views/disconnected";
import { renderNeedsLogin } from "./views/needs-login";
import { renderNeedsInstall } from "./views/needs-install";
import { renderNeedsUpdate } from "./views/needs-update";
import { showToast } from "./utils";
import { loadCustomUrls } from "./custom-urls";

// --- Port management ---

let port: chrome.runtime.Port | null = null;

/**
 * Send a message to the background service worker.
 * Exported for use by components and views.
 */
/**
 * Call when entering a sub-view (exit nodes, profiles) to prevent
 * state updates from clobbering the overlay.
 */
export function enterSubView(updater?: (state: TailscaleState) => void): void {
  subViewActive = true;
  deferredState = null;
  subViewUpdater = updater ?? null;
  subViewSnapshot = null;
}

/**
 * Call when leaving a sub-view. Applies any deferred state update.
 */
export function leaveSubView(): void {
  subViewActive = false;
  subViewUpdater = null;
  subViewSnapshot = null;
  const state = deferredState ?? lastKnownState;
  deferredState = null;
  if (state) {
    currentView = null;
    lastStateSnapshot = null;
    render(state);
  }
}

export function sendMessage(msg: BackgroundMessage): void {
  if (port) {
    port.postMessage(msg);
  } else {
    console.warn("[popup] Cannot send message, port not connected:", msg);
    showToast("Connection lost. Please reopen the popup.", "error");
  }
}

// --- View routing ---

/** Tracks which view is currently rendered to avoid unnecessary re-renders. */
let currentView: string | null = null;
/** Tracks a serialized snapshot of the last rendered state for the same view. */
let lastStateSnapshot: string | null = null;
/** When a sub-view (exit nodes, profiles) is active, defer main re-renders until it closes. */
let subViewActive = false;
let deferredState: TailscaleState | null = null;
/** Optional callback to live-update the active sub-view when new state arrives. */
let subViewUpdater: ((state: TailscaleState) => void) | null = null;
/** Snapshot of the last state sent to the sub-view updater, to skip redundant re-renders. */
let subViewSnapshot: string | null = null;
/** Last state passed to render(), so we can always re-render on sub-view exit. */
let lastKnownState: TailscaleState | null = null;

/**
 * Returns the most recent state received from the background.
 * Used by click handlers that need fresh state rather than closure-captured state.
 */
export function getLatestState(): TailscaleState | null {
  return lastKnownState;
}

/**
 * Determines the view name for a given state.
 */
export function viewForState(state: TailscaleState): string {
  if (state.installError) return "needs-install";
  if (state.hostVersionMismatch) return "needs-update";
  if (state.backendState === "NeedsLogin") return "needs-login";
  if (state.backendState === "Running") return "connected";
  return "disconnected";
}

/**
 * Renders the appropriate view into the root element based on the current state.
 */
function render(state: TailscaleState): void {
  const root = document.getElementById("root");
  if (!root) return;

  lastKnownState = state;

  // If a sub-view is active, live-update it or defer main re-render
  if (subViewActive) {
    deferredState = state;
    if (subViewUpdater) {
      const snap = JSON.stringify(state);
      if (snap !== subViewSnapshot) {
        subViewSnapshot = snap;
        subViewUpdater(state);
      }
    }
    return;
  }

  const view = viewForState(state);
  const snapshot = JSON.stringify(state);

  // Skip re-render if same view and same state
  if (view === currentView && snapshot === lastStateSnapshot) {
    return;
  }

  currentView = view;
  lastStateSnapshot = snapshot;

  switch (view) {
    case "needs-install":
      renderNeedsInstall(root);
      break;
    case "needs-update":
      renderNeedsUpdate(root, state.hostVersion);
      break;
    case "needs-login":
      renderNeedsLogin(root, state);
      break;
    case "connected":
      renderConnected(root, state);
      break;
    case "disconnected":
    default:
      renderDisconnected(root, state);
      break;
  }
}

// --- Initialization ---

async function init(): Promise<void> {
  // Render disconnected view immediately so the popup is never empty
  const root = document.getElementById("root");
  if (root) renderDisconnected(root);

  // Load per-device custom URL settings before rendering peer list
  await loadCustomUrls();

  // Connect to the background service worker
  port = chrome.runtime.connect({ name: "popup" });

  // Listen for messages from background
  port.onMessage.addListener((msg: PopupMessage) => {
    switch (msg.type) {
      case "state":
        render(msg.state);
        break;
      case "toast":
        showToast(msg.message, msg.level);
        break;
    }
  });

  // Handle port disconnect (background service worker restart, etc.)
  port.onDisconnect.addListener(() => {
    port = null;
    console.warn("[popup] Port disconnected from background");
  });
}

// Run when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
