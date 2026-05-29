import type { TailscaleState } from "../../types";
import { renderHeader } from "../components/header";
import { renderUiSurfaceFooter } from "../components/ui-surface-row";
import {
  createCoordinationServerRow,
  updateCoordinationServerRow,
} from "../components/coordination-server-row";
import { sendMessage } from "../popup";
import { iconLock } from "../icons";

/** UI-only: whether the coordination-server editor on the login screen is expanded. */
let needsLoginCoordOpen = false;

/**
 * Renders the login-required view.
 * Shows a header with a disabled toggle and a prominent login button.
 */
export function renderNeedsLogin(root: HTMLElement, state: TailscaleState): void {
  root.textContent = "";
  const view = document.createElement("div");
  view.className = "view";

  // Header with toggle disabled
  renderHeader(view, true, true);

  // Centered content
  const content = document.createElement("div");
  content.className = "centered-view";

  const icon = document.createElement("div");
  icon.className = "centered-view-icon";
  const iconEl = document.createElement("span");
  iconEl.className = "icon icon-2xl";
  iconEl.appendChild(iconLock());
  icon.appendChild(iconEl);

  const title = document.createElement("h2");
  title.className = "centered-view-title";
  title.textContent = "Log in to Tailscale";

  const description = document.createElement("p");
  description.className = "centered-view-text";
  description.textContent =
    "You need to authenticate to connect this browser to your tailnet.";

  const loginBtn = document.createElement("button");
  loginBtn.className = "btn btn-primary btn-lg";
  loginBtn.textContent = "Log In";
  loginBtn.addEventListener("click", () => {
    // Notify background to open the validated login URL
    sendMessage({ type: "login" });
  });

  content.appendChild(icon);
  content.appendChild(title);
  content.appendChild(description);
  content.appendChild(loginBtn);
  view.appendChild(content);

  // Coordination server editor — lets users point at a custom control plane
  // (e.g. Headscale) before pressing Log In, since once we click Log In we
  // open a URL whose origin must match the currently-configured server.
  const settings = document.createElement("div");
  settings.className = "quick-settings";
  const coordRow = createCoordinationServerRow(state, needsLoginCoordOpen, (open) => {
    needsLoginCoordOpen = open;
  });
  settings.appendChild(coordRow.header);
  settings.appendChild(coordRow.editor);
  view.appendChild(settings);

  renderUiSurfaceFooter(view);

  root.appendChild(view);
}

/**
 * Patches the needs-login view in place. Used when the popup stays on this
 * view across status updates so a partially-typed coordination URL is not
 * discarded by a full re-render.
 */
export function updateNeedsLogin(root: HTMLElement, state: TailscaleState): void {
  const view = root.querySelector(".view");
  if (!view) {
    renderNeedsLogin(root, state);
    return;
  }

  if (!updateCoordinationServerRow(view, state)) {
    renderNeedsLogin(root, state);
  }
}
