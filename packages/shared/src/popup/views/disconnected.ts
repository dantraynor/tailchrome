import type { TailscaleState } from "../../types";
import { renderHeader } from "../components/header";

/**
 * Renders the disconnected view.
 * Shows the header with toggle off and a message prompting the user to connect.
 * When state is provided, disables the toggle and shows contextual messaging
 * for transitional or unactionable backend states.
 */
export function renderDisconnected(root: HTMLElement, state?: TailscaleState): void {
  root.textContent = "";
  const view = document.createElement("div");
  view.className = "view";

  // Determine toggle and subtitle based on backend state
  let disabled = false;
  let subtitleText = "Toggle the switch to connect to your tailnet.";
  let showSpinner = false;

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
    icon.textContent = "\uD83D\uDD0C"; // electric plug
    content.appendChild(icon);
  }

  const title = document.createElement("h2");
  title.className = "centered-view-title";
  title.textContent = state?.reconnecting
    ? "Reconnecting\u2026"
    : "Tailscale is not connected";

  const subtitle = document.createElement("p");
  subtitle.className = "centered-view-text";
  subtitle.textContent = subtitleText;

  content.appendChild(title);
  content.appendChild(subtitle);
  view.appendChild(content);

  root.appendChild(view);
}
