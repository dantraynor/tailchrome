import type { TailscaleState } from "../../types";
import {
  appendCoordinationServerSettings,
  rerenderPreservingCoordEdit,
} from "../components/coordination-server-row";
import { renderHeader } from "../components/header";
import { renderUiSurfaceFooter } from "../components/ui-surface-row";
import { iconPlug, iconWarning } from "../icons";
import { sendMessage } from "../popup";
import { appendHelperDiagnosticActions } from "../helper-diagnostics";

/**
 * Renders the disconnected view.
 * Shows the header with toggle off and a message prompting the user to connect.
 * When state is provided, disables the toggle and shows contextual messaging
 * for transitional or unactionable backend states.
 * Shows error recovery hints when an error is present.
 */
export function renderDisconnected(root: HTMLElement, state?: TailscaleState): void {
  root.textContent = "";
  const view = document.createElement("div");
  view.className = "view";

  // Determine toggle and subtitle based on backend state
  let disabled = false;
  let subtitleText = "Toggle the switch to connect to your tailnet.";
  let showSpinner = false;
  let showError = false;
  let recoveryHints = [
    "Retry the helper connection",
    "Reinstall or repair the verified release package",
    "Restart the browser after repairing registration",
  ];

  if (state) {
    if (state.helperFailure) {
      showError = true;
      disabled = true;
      showSpinner = state.reconnecting;
      switch (state.helperFailure.kind) {
        case "helper-start-failed":
          subtitleText =
            "The browser found the helper, but it stopped before setup completed.";
          break;
        case "helper-stopped":
          subtitleText =
            "The helper stopped after connecting. Tailchrome is retrying.";
          recoveryHints = [
            "Tailchrome will retry automatically",
            "Use Retry Connection to try again now",
          ];
          break;
        case "helper-reported-error":
          subtitleText =
            "The helper started but reported a startup error.";
          recoveryHints = [
            "Retry after reviewing the setup guidance",
            "Reinstall or repair the verified release package",
          ];
          break;
        case "helper-incompatible":
          subtitleText =
            "The helper and extension reported an incompatible protocol.";
          break;
        case "helper-unavailable":
          subtitleText =
            "Tailchrome could not find a registered helper for this browser.";
          break;
        case "helper-not-allowed":
          subtitleText =
            "This browser refused access to the registered helper.";
          break;
      }
    } else if (state.reconnecting) {
      disabled = true;
      subtitleText = "Reconnecting to Tailscale\u2026";
      showSpinner = true;
    } else {
      switch (state.backendState) {
        case "Starting":
          disabled = true;
          subtitleText = "Tailscale is starting\u2026";
          showSpinner = true;
          break;
        case "NeedsMachineAuth":
          disabled = true;
          subtitleText = "Waiting for admin approval to join the tailnet.";
          break;
        case "InUseOtherUser":
          disabled = true;
          subtitleText = "Tailscale is in use by another user on this machine.";
          break;
      }
    }

    if (!state.helperFailure && state.error) {
      showError = true;
      subtitleText = "Tailscale reported a problem.";
    } else if (
      !state.helperFailure &&
      !state.reconnecting &&
      !state.hostConnected &&
      state.backendState !== "Starting"
    ) {
      showError = true;
      subtitleText = "Unable to reach the helper app.";
    }
  }

  // Header with toggle off
  renderHeader(view, false, disabled);

  // Centered content
  const content = document.createElement("div");
  content.className = "centered-view";

  if (showSpinner) {
    const spinner = document.createElement("div");
    spinner.className = "spinner";
    spinner.style.marginBottom = "16px";
    content.appendChild(spinner);
  } else {
    const icon = document.createElement("div");
    icon.className = "centered-view-icon";
    const iconEl = document.createElement("span");
    iconEl.className = "icon icon-2xl";
    iconEl.appendChild(showError ? iconWarning() : iconPlug());
    icon.appendChild(iconEl);
    content.appendChild(icon);
  }

  const title = document.createElement("h2");
  title.className = "centered-view-title";
  title.textContent = showError
    ? state?.helperFailure
      ? "Helper Connection Issue"
      : "Connection Issue"
    : state?.reconnecting
      ? "Reconnecting\u2026"
      : "Tailscale is not connected";

  const subtitle = document.createElement("p");
  subtitle.className = "centered-view-text";
  subtitle.textContent = subtitleText;

  content.appendChild(title);
  content.appendChild(subtitle);

  // Error recovery hints
  if (showError) {
    const details = document.createElement("div");
    details.className = "error-details";

    for (const hint of recoveryHints) {
      const row = document.createElement("div");
      row.className = "error-detail-row";

      const bullet = document.createElement("span");
      bullet.className = "error-detail-bullet";
      bullet.textContent = "\u2022";

      const text = document.createElement("span");
      text.textContent = hint;

      row.appendChild(bullet);
      row.appendChild(text);
      details.appendChild(row);
    }

    content.appendChild(details);

    // Retry button
    const retryBtn = document.createElement("button");
    retryBtn.className = "btn btn-secondary btn-retry";
    retryBtn.textContent = "Retry Connection";
    retryBtn.addEventListener("click", () => {
      retryBtn.disabled = true;
      retryBtn.textContent = "Retrying\u2026";
      sendMessage({ type: "retry-native-host", source: "manual" });
      // Re-enable after a short delay
      setTimeout(() => {
        retryBtn.disabled = false;
        retryBtn.textContent = "Retry Connection";
      }, 3000);
    });
    content.appendChild(retryBtn);

    if (
      state?.helperFailure?.kind === "helper-start-failed" ||
      state?.helperFailure?.kind === "helper-reported-error"
    ) {
      const reinstall = document.createElement("button");
      reinstall.type = "button";
      reinstall.className = "btn btn-secondary helper-reinstall";
      reinstall.textContent = "Reinstall or repair helper";
      reinstall.addEventListener("click", () => {
        const releaseVersion = chrome.runtime.getManifest().version;
        void chrome.tabs.create({
          url: `https://github.com/dantraynor/tailchrome/releases/tag/v${releaseVersion}`,
        });
      });
      content.appendChild(reinstall);
    }

    if (state) {
      appendHelperDiagnosticActions(content, state);
    }
  }

  view.appendChild(content);

  if (state) {
    appendCoordinationServerSettings(view, state);
  }

  renderUiSurfaceFooter(view);
  root.appendChild(view);
}

/**
 * In-place update path for the disconnected view. Re-renders so all
 * state-dependent messaging (spinner, error hints, retry) stays fresh, while
 * preserving an in-progress coordination-server edit (value, focus, caret).
 */
export function updateDisconnected(root: HTMLElement, state: TailscaleState): void {
  rerenderPreservingCoordEdit(root, state, renderDisconnected);
}
