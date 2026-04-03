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

  if (state) {
    switch (state.backendState) {
      case "Starting":
        disabled = true;
        subtitleText = "Tailscale is starting\u2026";
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

  // Header with toggle off
  renderHeader(view, false, disabled);

  // Centered content
  const content = document.createElement("div");
  content.className = "centered-view";

  const icon = document.createElement("div");
  icon.className = "centered-view-icon";
  icon.textContent = "\uD83D\uDD0C"; // electric plug

  const title = document.createElement("h2");
  title.className = "centered-view-title";
  title.textContent = "Tailscale is not connected";

  const subtitle = document.createElement("p");
  subtitle.className = "centered-view-text";
  subtitle.textContent = subtitleText;

  content.appendChild(icon);
  content.appendChild(title);
  content.appendChild(subtitle);
  view.appendChild(content);

  root.appendChild(view);
}
