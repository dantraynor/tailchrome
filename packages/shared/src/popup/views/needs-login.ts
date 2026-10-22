import type { TailscaleState } from "../../types";
import { renderHeader } from "../components/header";
import { renderUiSurfaceFooter } from "../components/ui-surface-row";
import {
  appendCoordinationServerSettings,
  rerenderPreservingCoordEdit,
} from "../components/coordination-server-row";
import { sendMessage } from "../popup";
import { iconLock } from "../icons";

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

  const protectedRouting =
    state.routingPolicy != null && state.routingPolicy.mode !== "direct";
  const description = document.createElement("p");
  description.className = "centered-view-text";
  description.textContent = protectedRouting
    ? "Disconnect protected browsing to sign in using your normal connection."
    : "You need to authenticate to connect this browser to your tailnet.";

  const loginBtn = document.createElement("button");
  loginBtn.className = "btn btn-primary btn-lg";
  loginBtn.textContent = protectedRouting ? "Disconnect and log in" : "Log In";
  loginBtn.addEventListener("click", () => {
    // Notify background to open the validated login URL
    sendMessage({ type: protectedRouting ? "disconnect-and-login" : "login" });
  });

  content.appendChild(icon);
  content.appendChild(title);
  content.appendChild(description);
  content.appendChild(loginBtn);
  content.appendChild(createAuthKeyLogin(state));
  view.appendChild(content);

  // Coordination server editor — lets users point at a custom control plane
  // (e.g. Headscale) before pressing Log In, since once we click Log In we
  // open a URL whose origin must match the currently-configured server.
  appendCoordinationServerSettings(view, state);

  renderUiSurfaceFooter(view);

  root.appendChild(view);
}

/** Whether the auth-key form is expanded; kept across re-renders. */
let authKeyOpen = false;

/**
 * Optional sign-in with a pre-authorized auth key (#154), for people who
 * cannot complete an interactive login. The key lives only in this input until
 * it is sent to the helper; it is never written to extension storage.
 */
function createAuthKeyLogin(state: TailscaleState): HTMLElement {
  const details = document.createElement("details");
  details.className = "auth-key-login";
  details.open = authKeyOpen;
  details.addEventListener("toggle", () => {
    authKeyOpen = details.open;
  });

  const summary = document.createElement("summary");
  summary.textContent = "Use an auth key";
  details.appendChild(summary);

  const form = document.createElement("form");
  form.className = "auth-key-form";

  const input = document.createElement("input");
  input.type = "password";
  input.className = "auth-key-input";
  input.placeholder = "tskey-auth-…";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.autocapitalize = "off";
  input.setAttribute("aria-label", "Auth key");

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "btn btn-secondary auth-key-submit";
  submit.textContent = "Sign in with key";

  const note = document.createElement("p");
  note.className = "auth-key-note";
  const supported = state.supportsAuthKeyLogin;
  input.disabled = !supported;
  submit.disabled = !supported;
  note.textContent = supported
    ? "Paste a pre-authorized key from your tailnet admin. It is used for this sign-in only and is not saved."
    : "Update the native helper to sign in with an auth key.";

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const authKey = input.value.trim();
    if (!authKey || submit.disabled) return;
    sendMessage({ type: "login-with-auth-key", authKey });
    input.value = "";
    note.textContent = "Signing in…";
  });

  form.append(input, submit);
  details.append(form, note);
  return details;
}

/**
 * In-place update path for the needs-login view. Re-renders the view while
 * preserving an in-progress coordination-server edit (value, focus, caret) and
 * a typed auth key, so neither is discarded by a status update.
 */
export function updateNeedsLogin(root: HTMLElement, state: TailscaleState): void {
  const keyInput = root.querySelector<HTMLInputElement>(".auth-key-input");
  const typedKey = keyInput?.value ?? "";
  const keyFocused = keyInput !== null && document.activeElement === keyInput;
  rerenderPreservingCoordEdit(root, state, renderNeedsLogin);
  const nextKeyInput = root.querySelector<HTMLInputElement>(".auth-key-input");
  if (nextKeyInput && typedKey) nextKeyInput.value = typedKey;
  if (nextKeyInput && keyFocused) nextKeyInput.focus();
}
