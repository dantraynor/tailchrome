import type { TailscaleState, PopupMessage, BackgroundMessage } from "../types";
import { renderConnected, updateConnected } from "./views/connected";
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
  subViewVersion = -1;
}

/**
 * Call when leaving a sub-view. Applies any deferred state update.
 */
export function leaveSubView(): void {
  subViewActive = false;
  subViewUpdater = null;
  subViewVersion = -1;
  const state = deferredState ?? lastKnownState;
  deferredState = null;
  if (state) {
    currentView = null;
    lastStateVersion = -1;
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
/** Tracks the stateVersion of the last rendered state to cheaply skip redundant renders. */
let lastStateVersion = -1;
/** When a sub-view (exit nodes, profiles) is active, defer main re-renders until it closes. */
let subViewActive = false;
let deferredState: TailscaleState | null = null;
/** Optional callback to live-update the active sub-view when new state arrives. */
let subViewUpdater: ((state: TailscaleState) => void) | null = null;
/** stateVersion of the last state sent to the sub-view updater. */
let subViewVersion = -1;
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
    if (subViewUpdater && state.stateVersion !== subViewVersion) {
      subViewVersion = state.stateVersion;
      subViewUpdater(state);
    }
    return;
  }

  const view = viewForState(state);

  // Skip re-render if same view and same state version
  if (view === currentView && state.stateVersion === lastStateVersion) {
    return;
  }

  const isSameView = view === currentView;
  currentView = view;
  lastStateVersion = state.stateVersion;

  // For the connected view, use in-place patching when possible
  if (view === "connected" && isSameView) {
    updateConnected(root, state);
    return;
  }

  // Full render for view transitions or simple views
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

function init(): void {
  // Render disconnected view immediately so the popup is never empty
  const root = document.getElementById("root");
  if (root) renderDisconnected(root);

  // Load per-device custom URL settings in parallel (doesn't block port connection)
  loadCustomUrls();

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
