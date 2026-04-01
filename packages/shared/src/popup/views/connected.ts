import type { TailscaleState } from "../../types";
import { ADMIN_URL } from "../../constants";
import { renderHeader } from "../components/header";
import { renderPeerList } from "../components/peer-list";
import { renderHealthWarnings } from "../components/health-warnings";
import { createCopyButton } from "../utils";
import { sendMessage, enterSubView, leaveSubView, getLatestState } from "../popup";
import { createToggle } from "../components/toggle-switch";
import { renderExitNodes } from "./exit-nodes";
import { renderProfiles } from "./profiles";

type SubViewRenderer = (root: HTMLElement, state: TailscaleState, onBack: () => void) => void;

function openSubView(root: HTMLElement, renderFn: SubViewRenderer): void {
  const currentState = getLatestState();
  if (!currentState) return;
  const onBack = () => { leaveSubView(); };
  enterSubView((newState) => {
    try {
      renderFn(root, newState, onBack);
    } catch (err) {
      console.error("[popup] Failed to update sub-view:", err);
    }
  });
  try {
    renderFn(root, currentState, onBack);
  } catch (err) {
    console.error("[popup] Failed to render sub-view:", err);
    leaveSubView();
  }
}

/**
 * Renders the connected view: header, status bar, quick settings, peer list, footer.
 */
export function renderConnected(root: HTMLElement, state: TailscaleState): void {
  root.textContent = "";
  const view = document.createElement("div");
  view.className = "view";

  // --- Header ---
  renderHeader(view, true);

  // --- Status Bar ---
  const statusBar = document.createElement("div");
  statusBar.className = "status-bar";

  // Tailnet name row
  const tailnetRow = document.createElement("div");
  tailnetRow.className = "status-bar-row";

  const dot = document.createElement("span");
  dot.className = "status-bar-dot";
  tailnetRow.appendChild(dot);

  const tailnetName = document.createElement("span");
  tailnetName.className = "status-bar-tailnet";
  tailnetName.textContent = state.tailnet || "My Tailnet";
  tailnetRow.appendChild(tailnetName);

  statusBar.appendChild(tailnetRow);

  // Self IP + hostname row
  if (state.selfNode) {
    const ipRow = document.createElement("div");
    ipRow.className = "status-bar-row";

    const ipSpan = document.createElement("span");
    ipSpan.className = "status-bar-ip";
    const firstIP = state.selfNode.tailscaleIPs[0];
    ipSpan.textContent = firstIP ?? "";
    ipRow.appendChild(ipSpan);

    if (firstIP) {
      ipRow.appendChild(createCopyButton(firstIP));
    }

    statusBar.appendChild(ipRow);

    const hostnameRow = document.createElement("div");
    hostnameRow.className = "status-bar-row";
    const hostname = document.createElement("span");
    hostname.className = "status-bar-hostname";
    hostname.textContent = state.selfNode.hostname;
    hostnameRow.appendChild(hostname);
    statusBar.appendChild(hostnameRow);
  }

  view.appendChild(statusBar);

  // --- Health Warnings ---
  if (state.health.length > 0) {
    renderHealthWarnings(view, state.health);
  }

  // --- Quick Settings ---
  const settings = document.createElement("div");
  settings.className = "quick-settings";

  // Exit Node
  const exitRow = document.createElement("div");
  exitRow.className = "setting-row setting-row--clickable";

  const exitLabel = document.createElement("span");
  exitLabel.className = "setting-label";
  exitLabel.textContent = "Exit Node";
  exitRow.appendChild(exitLabel);

  const exitValue = document.createElement("span");
  exitValue.className = "setting-value";
  if (state.exitNode) {
    exitValue.textContent = state.exitNode.location
      ? `${state.exitNode.location.city}, ${state.exitNode.location.countryCode}`
      : state.exitNode.hostname;
  } else {
    exitValue.textContent = "None";
  }

  const chevron = document.createElement("span");
  chevron.className = "setting-value-chevron";
  chevron.textContent = "\u203A";
  exitValue.appendChild(chevron);

  exitRow.appendChild(exitValue);
  exitRow.addEventListener("click", () => openSubView(root, renderExitNodes));
  settings.appendChild(exitRow);

  // Shields Up toggle
  const shieldsRow = document.createElement("div");
  shieldsRow.className = "setting-row";

  const shieldsLabel = document.createElement("span");
  shieldsLabel.className = "setting-label";
  shieldsLabel.textContent = "Shields Up";
  shieldsRow.appendChild(shieldsLabel);

  const shieldsUp = state.prefs?.shieldsUp ?? false;
  const shieldsToggle = createToggle(shieldsUp, (checked) => {
    sendMessage({ type: "set-pref", key: "shieldsUp", value: checked });
  });
  shieldsRow.appendChild(shieldsToggle);
  settings.appendChild(shieldsRow);

  // MagicDNS toggle
  const dnsRow = document.createElement("div");
  dnsRow.className = "setting-row";

  const dnsLabel = document.createElement("span");
  dnsLabel.className = "setting-label";
  dnsLabel.textContent = "MagicDNS";
  dnsRow.appendChild(dnsLabel);

  const corpDNSEnabled = state.prefs?.corpDNS ?? true;
  const dnsToggle = createToggle(corpDNSEnabled, (checked) => {
    sendMessage({ type: "set-pref", key: "corpDNS", value: checked });
  });
  dnsRow.appendChild(dnsToggle);
  settings.appendChild(dnsRow);

  // Profile switcher row (only show when multiple profiles exist)
  if (state.profiles.length > 0) {
    const profileRow = document.createElement("div");
    profileRow.className = "setting-row setting-row--clickable";

    const profileLabel = document.createElement("span");
    profileLabel.className = "setting-label";
    profileLabel.textContent = "Profile";
    profileRow.appendChild(profileLabel);

    const profileValue = document.createElement("span");
    profileValue.className = "setting-value";
    profileValue.textContent = state.currentProfile?.name ?? "Default";

    const profileChevron = document.createElement("span");
    profileChevron.className = "setting-value-chevron";
    profileChevron.textContent = "\u203A";
    profileValue.appendChild(profileChevron);

    profileRow.appendChild(profileValue);
    profileRow.addEventListener("click", () => openSubView(root, renderProfiles));
    settings.appendChild(profileRow);
  }

  view.appendChild(settings);

  // --- Peer List ---
  const peerContainer = document.createElement("div");
  renderPeerList(peerContainer, state.peers, { magicDNS: state.prefs?.corpDNS ?? true });
  view.appendChild(peerContainer);

  // --- Footer ---
  const footer = document.createElement("div");
  footer.className = "footer";

  const adminLink = document.createElement("a");
  adminLink.className = "footer-link";
  adminLink.textContent = "Admin Console";
  adminLink.href = "#";
  adminLink.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: ADMIN_URL });
  });

  const logoutLink = document.createElement("a");
  logoutLink.className = "footer-link footer-link--danger";
  logoutLink.textContent = "Logout";
  logoutLink.href = "#";
  logoutLink.addEventListener("click", (e) => {
    e.preventDefault();
    sendMessage({ type: "logout" });
  });

  const sep1 = document.createElement("span");
  sep1.className = "footer-sep";

  const sep2 = document.createElement("span");
  sep2.className = "footer-sep";

  const settingsLink = document.createElement("a");
  settingsLink.className = "footer-link";
  settingsLink.textContent = "Settings";
  settingsLink.href = "#";
  settingsLink.addEventListener("click", (e) => {
    e.preventDefault();
    sendMessage({ type: "open-web-client" });
  });

  footer.appendChild(adminLink);
  footer.appendChild(sep1);
  footer.appendChild(settingsLink);
  footer.appendChild(sep2);
  footer.appendChild(logoutLink);
  view.appendChild(footer);

  root.appendChild(view);
}
