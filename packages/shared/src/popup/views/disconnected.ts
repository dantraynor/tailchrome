import { renderHeader } from "../components/header";

/**
 * Renders the disconnected view.
 * Shows the header with toggle off and a message prompting the user to connect.
 */
export function renderDisconnected(root: HTMLElement): void {
  root.textContent = "";
  const view = document.createElement("div");
  view.className = "view";

  // Header with toggle off
  renderHeader(view, false);

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
  subtitle.textContent = "Toggle the switch to connect to your tailnet.";

  content.appendChild(icon);
  content.appendChild(title);
  content.appendChild(subtitle);
  view.appendChild(content);

  root.appendChild(view);
}
