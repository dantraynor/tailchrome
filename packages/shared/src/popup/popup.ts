import type { TailscaleState, PopupMessage, BackgroundMessage } from "../types";
import { renderConnected, updateConnected } from "./views/connected";
import { renderDisconnected, updateDisconnected } from "./views/disconnected";
import { renderNeedsLogin, updateNeedsLogin } from "./views/needs-login";
import { renderNeedsInstall } from "./views/needs-install";
import { showToast } from "./utils";
import { loadCustomUrls } from "./custom-urls";

let port: chrome.runtime.Port | null = null;
let helperVersionNoticeDismissed = false;

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

/** Posts to the background service worker; shows a toast if the port is gone. */
export function sendMessage(msg: BackgroundMessage): void {
  if (port) {
    port.postMessage(msg);
  } else {
    console.warn("[popup] Cannot send message, port not connected:", msg);
    showToast("Connection lost. Please reopen the popup.", "error");
  }
}

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
  if (
    state.helperFailure?.kind === "helper-unavailable" ||
    state.helperFailure?.kind === "helper-not-allowed" ||
    state.helperFailure?.kind === "helper-incompatible"
  ) {
    return "needs-install";
  }
  if (state.backendState === "NeedsLogin") return "needs-login";
  if (state.backendState === "Running") return "connected";
  return "disconnected";
}

/**
 * Renders the appropriate view into the root element based on the current state.
 */
export function render(state: TailscaleState): void {
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

  // For views with editable inputs (connected, needs-login), patch in place
  // when staying on the same view so in-flight edits aren't clobbered by a
  // status-update re-render.
  if (view === "connected" && isSameView) {
    updateConnected(root, state);
    syncHelperVersionNotice(root, state);
    return;
  }
  if (view === "needs-login" && isSameView) {
    updateNeedsLogin(root, state);
    syncHelperVersionNotice(root, state);
    return;
  }
  if (view === "disconnected" && isSameView) {
    updateDisconnected(root, state);
    syncHelperVersionNotice(root, state);
    return;
  }

  // Full render for view transitions or simple views
  switch (view) {
    case "needs-install":
      void renderNeedsInstall(root, state).then(() => {
        if (
          currentView === "needs-install" &&
          lastKnownState?.stateVersion === state.stateVersion
        ) {
          syncHelperVersionNotice(root, state);
        }
      });
      return;
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
  syncHelperVersionNotice(root, state);
}

function syncHelperVersionNotice(
  root: HTMLElement,
  state: TailscaleState,
): void {
  root.querySelector(".helper-version-notice")?.remove();
  const notice = state.helperVersionNotice;
  if (!notice || helperVersionNoticeDismissed) return;

  const view = root.querySelector<HTMLElement>(".view");
  if (!view) return;
  const container = document.createElement("section");
  container.className = "helper-version-notice";
  container.setAttribute("role", "status");

  const copy = document.createElement("p");
  copy.className = "helper-version-copy";
  copy.textContent =
    `Helper ${notice.installedVersion} is ${notice.relation} than companion release ${notice.releaseVersion}. ` +
    "Available features remain usable.";
  if (notice.relation === "different") {
    copy.textContent =
      `Helper ${notice.installedVersion} differs from companion release ${notice.releaseVersion}. ` +
      "Available features remain usable.";
  }

  const releaseLink = document.createElement("a");
  releaseLink.href = "#";
  releaseLink.textContent =
    notice.relation === "older"
      ? "View release installer"
      : "View release information";
  releaseLink.addEventListener("click", (event) => {
    event.preventDefault();
    void chrome.tabs.create({
      url: `https://github.com/dantraynor/tailchrome/releases/tag/v${notice.releaseVersion}`,
    });
  });

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "helper-version-dismiss";
  dismiss.setAttribute("aria-label", "Dismiss helper version notice");
  dismiss.textContent = "\u00d7";
  dismiss.addEventListener("click", () => {
    helperVersionNoticeDismissed = true;
    container.remove();
  });

  container.append(copy, releaseLink, dismiss);
  const header = view.querySelector<HTMLElement>(":scope > .header");
  if (header) {
    header.insertAdjacentElement("afterend", container);
  } else {
    view.prepend(container);
  }
}

async function init(): Promise<void> {
  // The HTML skeleton placeholder is shown until real state arrives.

  // Hydrate the cache before the background can synchronously send state.
  try {
    await loadCustomUrls();
  } catch (err) {
    console.warn("[popup] Failed to load custom URLs:", err);
  }

  // Connect to the background service worker
  port = chrome.runtime.connect({ name: "popup" });

  // Listen for messages from background
  port.onMessage.addListener((msg: PopupMessage) => {
    switch (msg.type) {
      case "state":
        render(msg.state);
        break;
      case "toast":
        showToast(msg.message, {
          level: msg.level,
          persistent: msg.persistent,
          dismissMs: msg.dismissMs,
          multiline: msg.multiline,
        });
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
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}
