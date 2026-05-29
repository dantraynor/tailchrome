import type { TailscaleState } from "../../types";
import {
  createCoordinationServerRow,
  updateCoordinationServerRow,
} from "../components/coordination-server-row";
import { renderHeader } from "../components/header";
import { renderUiSurfaceFooter } from "../components/ui-surface-row";
import { iconPlug, iconWarning } from "../icons";
import { sendMessage } from "../popup";

/** UI-only: whether the coordination-server editor on the disconnected screen is expanded. */
let disconnectedCoordOpen = false;

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

  if (state) {
    if (state.reconnecting) {
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

    if (state.error) {
      showError = true;
      subtitleText = state.error;
    } else if (!state.hostConnected && state.backendState !== "Starting") {
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
    ? "Connection Issue"
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

    const hints = [
      "Close and reopen this popup to retry",
      "Check that the helper app is installed",
      "Try restarting your browser",
    ];

    for (const hint of hints) {
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
      sendMessage({ type: "toggle" });
      // Re-enable after a short delay
      setTimeout(() => {
        retryBtn.disabled = false;
        retryBtn.textContent = "Retry Connection";
      }, 3000);
    });
    content.appendChild(retryBtn);
  }

  view.appendChild(content);

  if (state) {
    const settings = document.createElement("div");
    settings.className = "quick-settings";
    const coordRow = createCoordinationServerRow(state, disconnectedCoordOpen, (open) => {
      disconnectedCoordOpen = open;
    });
    settings.appendChild(coordRow.header);
    settings.appendChild(coordRow.editor);
    view.appendChild(settings);
  }

  renderUiSurfaceFooter(view);
  root.appendChild(view);
}

/**
 * Patches the disconnected view when the coordination server editor is active.
 * Falls back to a full render otherwise so state-specific messaging stays fresh.
 */
export function updateDisconnected(root: HTMLElement, state: TailscaleState): void {
  const coordInput = root.querySelector<HTMLInputElement>(".coordination-server-input");
  if (document.activeElement !== coordInput) {
    renderDisconnected(root, state);
    return;
  }

  const view = root.querySelector(".view");
  if (!view || !updateCoordinationServerRow(view, state)) {
    renderDisconnected(root, state);
  }
}
