import type { TailscaleState } from "../../types";
import { ADMIN_URL } from "../../constants";
import { renderHeader } from "../components/header";
import { renderPeerList, updatePeerList, filterPeers } from "../components/peer-list";
import { renderHealthWarnings } from "../components/health-warnings";
import { createCopyButton } from "../utils";
import { sendMessage, enterSubView, leaveSubView, getLatestState } from "../popup";
import { createToggle } from "../components/toggle-switch";
import { renderExitNodes } from "./exit-nodes";
import { renderProfiles } from "./profiles";
import { iconChevronRight } from "../icons";

type SubViewRenderer = (root: HTMLElement, state: TailscaleState, onBack: () => void) => void;

/** Persists the peer search query across state updates within the connected view. */
let peerSearchQuery = "";

const PEER_SEARCH_THRESHOLD = 6;

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
  lastHealthKey = state.health.join("\0");
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
  const chevronIcon = document.createElement("span");
  chevronIcon.className = "icon";
  chevronIcon.appendChild(iconChevronRight());
  chevron.appendChild(chevronIcon);
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

  // Run as Exit Node toggle
  const exitAdRow = document.createElement("div");
  exitAdRow.className = "setting-row";

  const exitAdLabel = document.createElement("span");
  exitAdLabel.className = "setting-label";
  exitAdLabel.textContent = "Run as Exit Node";
  exitAdRow.appendChild(exitAdLabel);

  const advertisingExit = state.prefs?.advertiseExitNode ?? false;
  const exitAdToggle = createToggle(advertisingExit, (checked) => {
    sendMessage({ type: "set-pref", key: "advertiseExitNode", value: checked });
  });
  exitAdRow.appendChild(exitAdToggle);
  settings.appendChild(exitAdRow);

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
    const profileChevronIcon = document.createElement("span");
    profileChevronIcon.className = "icon";
    profileChevronIcon.appendChild(iconChevronRight());
    profileChevron.appendChild(profileChevronIcon);
    profileValue.appendChild(profileChevron);

    profileRow.appendChild(profileValue);
    profileRow.addEventListener("click", () => openSubView(root, renderProfiles));
    settings.appendChild(profileRow);
  }

  view.appendChild(settings);

  // --- Peer Search (only for larger peer lists) ---
  const filteredPeers = filterPeers(state.peers, peerSearchQuery);
  if (state.peers.length >= PEER_SEARCH_THRESHOLD) {
    const searchContainer = document.createElement("div");
    searchContainer.className = "peer-search-container";

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.className = "peer-search";
    searchInput.placeholder = "Search devices\u2026";
    searchInput.value = peerSearchQuery;
    searchInput.addEventListener("input", () => {
      peerSearchQuery = searchInput.value;
      const peerEl = view.querySelector<HTMLElement>(".peer-container");
      if (peerEl) {
        const latest = getLatestState();
        if (latest) {
          updatePeerList(peerEl, filterPeers(latest.peers, peerSearchQuery));
        }
      }
    });
    searchContainer.appendChild(searchInput);
    view.appendChild(searchContainer);
  }

  // --- Peer List ---
  const peerContainer = document.createElement("div");
  peerContainer.className = "peer-container";
  renderPeerList(peerContainer, filteredPeers);
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

// Track health key to detect changes during in-place updates
let lastHealthKey = "";

/**
 * Helper: compute the exit node display text from state.
 */
function exitNodeDisplayText(state: TailscaleState): string {
  if (state.exitNode) {
    return state.exitNode.location
      ? `${state.exitNode.location.city}, ${state.exitNode.location.countryCode}`
      : state.exitNode.hostname;
  }
  return "None";
}

/**
 * Updates the connected view in place, patching only changed elements.
 * Preserves peer expansion state and avoids full DOM teardown.
 */
export function updateConnected(root: HTMLElement, state: TailscaleState): void {
  const view = root.querySelector(".view");
  if (!view) {
    // Fallback: full render if DOM structure is unexpected
    renderConnected(root, state);
    return;
  }

  // If peer count crossed the search threshold, fall back to full render
  // so the search container is correctly added or removed.
  const hasSearchBox = view.querySelector(".peer-search-container") !== null;
  const shouldHaveSearchBox = state.peers.length >= PEER_SEARCH_THRESHOLD;
  if (hasSearchBox !== shouldHaveSearchBox) {
    renderConnected(root, state);
    return;
  }

  // --- Status Bar ---
  const tailnetEl = view.querySelector(".status-bar-tailnet");
  if (tailnetEl) {
    const newTailnet = state.tailnet || "My Tailnet";
    if (tailnetEl.textContent !== newTailnet) {
      tailnetEl.textContent = newTailnet;
    }
  }

  const ipEl = view.querySelector(".status-bar-ip");
  if (ipEl) {
    const newIP = state.selfNode?.tailscaleIPs[0] ?? "";
    if (ipEl.textContent !== newIP) {
      ipEl.textContent = newIP;
    }
  }

  const hostnameEl = view.querySelector(".status-bar-hostname");
  if (hostnameEl) {
    const newHostname = state.selfNode?.hostname ?? "";
    if (hostnameEl.textContent !== newHostname) {
      hostnameEl.textContent = newHostname;
    }
  }

  // --- Health Warnings ---
  const healthKey = state.health.join("\0");
  if (healthKey !== lastHealthKey) {
    lastHealthKey = healthKey;
    const existingHealth = view.querySelector(".health-warnings");
    if (existingHealth) existingHealth.remove();

    if (state.health.length > 0) {
      // Insert after status bar
      const statusBar = view.querySelector(".status-bar");
      const quickSettings = view.querySelector(".quick-settings");
      if (statusBar && quickSettings) {
        const tempContainer = document.createElement("div");
        renderHealthWarnings(tempContainer, state.health);
        const newHealth = tempContainer.firstElementChild;
        if (newHealth) {
          view.insertBefore(newHealth, quickSettings);
        }
      }
    }
  }

  // --- Quick Settings: Exit Node text ---
  const quickSettings = view.querySelector(".quick-settings");
  if (quickSettings) {
    const settingValues = quickSettings.querySelectorAll<HTMLElement>(".setting-value");
    // First .setting-value is exit node
    if (settingValues.length > 0) {
      const exitValueEl = settingValues[0]!;
      const newText = exitNodeDisplayText(state);
      // Update the text node (first child) while preserving the chevron span
      const textNode = exitValueEl.firstChild;
      if (textNode && textNode.nodeType === Node.TEXT_NODE) {
        if (textNode.textContent !== newText) {
          textNode.textContent = newText;
        }
      }
    }

    // Profile value (last .setting-value if profiles exist)
    if (state.profiles.length > 0 && settingValues.length > 1) {
      const profileValueEl = settingValues[settingValues.length - 1]!;
      const newProfileName = state.currentProfile?.name ?? "Default";
      const profileTextNode = profileValueEl.firstChild;
      if (profileTextNode && profileTextNode.nodeType === Node.TEXT_NODE) {
        if (profileTextNode.textContent !== newProfileName) {
          profileTextNode.textContent = newProfileName;
        }
      }
    }

    // Toggle states: Shields Up and MagicDNS
    const toggleInputs = quickSettings.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    if (toggleInputs.length >= 2) {
      const shieldsUp = state.prefs?.shieldsUp ?? false;
      if (toggleInputs[0]!.checked !== shieldsUp) {
        toggleInputs[0]!.checked = shieldsUp;
      }
      const corpDNS = state.prefs?.corpDNS ?? true;
      if (toggleInputs[1]!.checked !== corpDNS) {
        toggleInputs[1]!.checked = corpDNS;
      }
    }
  }

  // --- Peer List (incremental, with search filter applied) ---
  const peerContainer = view.querySelector<HTMLElement>(".peer-container");
  if (peerContainer) {
    updatePeerList(peerContainer, filterPeers(state.peers, peerSearchQuery));
  }
}
