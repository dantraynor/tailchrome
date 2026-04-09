import type { TailscaleState } from "../../types";
import { ADMIN_URL, TAILCHROME_PROJECT_URL } from "../../constants";
import { renderHeader } from "../components/header";
import { renderPeerList, updatePeerList, filterPeers } from "../components/peer-list";
import { peersForDeviceList } from "../peer-filters";
import { renderHealthWarnings } from "../components/health-warnings";
import { createCopyButton, formatKeyExpiryLocal } from "../utils";
import { sendMessage, enterSubView, leaveSubView, getLatestState } from "../popup";
import { createToggle } from "../components/toggle-switch";
import { renderExitNodes } from "./exit-nodes";
import { renderProfiles } from "./profiles";
import { iconChevronRight } from "../icons";

type SubViewRenderer = (root: HTMLElement, state: TailscaleState, onBack: () => void) => void;

/** Persists the peer search query across state updates within the connected view. */
let peerSearchQuery = "";

/** UI-only: whether the advertise-subnets editor (textarea + save) is visible. */
let advertiseRoutesEditorOpen = false;

/** UI-only: Advanced section (Run as Exit Node, local node page; peer SSH when expanded). */
let advancedSectionOpen = false;

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

  renderHeader(view, true);

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

    if (state.selfNode.keyExpiry) {
      const keyRow = document.createElement("div");
      keyRow.className = "status-bar-row status-bar-keyexpiry";
      keyRow.textContent = `Node key expires: ${formatKeyExpiryLocal(state.selfNode.keyExpiry)}`;
      statusBar.appendChild(keyRow);
    }
  }

  view.appendChild(statusBar);

  lastHealthKey = state.health.join("\0");
  if (state.health.length > 0) {
    renderHealthWarnings(view, state.health);
  }

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
  shieldsToggle.querySelector("input")?.classList.add("quick-settings-pref");
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
  dnsToggle.querySelector("input")?.classList.add("quick-settings-pref");
  dnsRow.appendChild(dnsToggle);
  settings.appendChild(dnsRow);

  const advancedPanel = document.createElement("div");
  advancedPanel.className = "advanced-settings-panel";
  if (!advancedSectionOpen) {
    advancedPanel.classList.add("hidden");
  }

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
  exitAdToggle.querySelector("input")?.classList.add("quick-settings-pref");
  exitAdRow.appendChild(exitAdToggle);
  advancedPanel.appendChild(exitAdRow);

  const localNodeRow = document.createElement("button");
  localNodeRow.type = "button";
  localNodeRow.className = "setting-row setting-row--clickable";

  const localNodeLabel = document.createElement("span");
  localNodeLabel.className = "setting-label";
  localNodeLabel.textContent = "Local node page";
  localNodeRow.appendChild(localNodeLabel);

  const localNodeValue = document.createElement("span");
  localNodeValue.className = "setting-value";
  localNodeValue.textContent = "Open";

  const localChevron = document.createElement("span");
  localChevron.className = "setting-value-chevron";
  const localChevronIcon = document.createElement("span");
  localChevronIcon.className = "icon";
  localChevronIcon.appendChild(iconChevronRight());
  localChevron.appendChild(localChevronIcon);
  localNodeValue.appendChild(localChevron);

  localNodeRow.appendChild(localNodeValue);
  localNodeRow.addEventListener("click", () => {
    sendMessage({ type: "open-web-client" });
  });
  advancedPanel.appendChild(localNodeRow);

  const advancedHeaderRow = document.createElement("div");
  advancedHeaderRow.className = "setting-row";
  const advancedLabel = document.createElement("span");
  advancedLabel.className = "setting-label";
  advancedLabel.textContent = "Advanced";
  advancedHeaderRow.appendChild(advancedLabel);
  const advancedExpandToggle = createToggle(advancedSectionOpen, (checked) => {
    advancedSectionOpen = checked;
    advancedPanel.classList.toggle("hidden", !checked);
    const peerEl = view.querySelector<HTMLElement>(".peer-container");
    if (peerEl) {
      const latest = getLatestState();
      if (latest) {
        updatePeerList(
          peerEl,
          filterPeers(peersForDeviceList(latest.peers), peerSearchQuery),
          latest.supportsPingPeer,
          advancedSectionOpen,
        );
      }
    }
  });
  advancedHeaderRow.appendChild(advancedExpandToggle);
  settings.appendChild(advancedHeaderRow);
  settings.appendChild(advancedPanel);

  const routesHeaderRow = document.createElement("div");
  routesHeaderRow.className = "setting-row";
  const routesLabel = document.createElement("span");
  routesLabel.className = "setting-label";
  routesLabel.textContent = "Advertise subnets";
  routesHeaderRow.appendChild(routesLabel);
  const routesExpandToggle = createToggle(advertiseRoutesEditorOpen, (checked) => {
    advertiseRoutesEditorOpen = checked;
    editorSection.classList.toggle("hidden", !checked);
  });
  routesHeaderRow.appendChild(routesExpandToggle);
  settings.appendChild(routesHeaderRow);

  const editorSection = document.createElement("div");
  editorSection.className = "setting-row setting-row--stacked advertise-routes-editor";
  if (!advertiseRoutesEditorOpen) {
    editorSection.classList.add("hidden");
  }
  const routesTa = document.createElement("textarea");
  routesTa.className = "advertise-routes-input";
  routesTa.rows = 2;
  routesTa.placeholder = "e.g. 10.0.0.0/24, 192.168.0.0/16";
  routesTa.value = (state.prefs?.advertiseRoutes ?? []).join(", ");
  editorSection.appendChild(routesTa);
  const routesSave = document.createElement("button");
  routesSave.type = "button";
  routesSave.className = "btn btn-secondary advertise-routes-save";
  routesSave.textContent = "Save routes";
  routesSave.addEventListener("click", () => {
    const parts = routesTa.value
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    sendMessage({ type: "set-advertise-routes", routes: parts });
  });
  editorSection.appendChild(routesSave);
  settings.appendChild(editorSection);

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

  const filteredPeers = filterPeers(
    peersForDeviceList(state.peers),
    peerSearchQuery,
  );
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
          updatePeerList(
            peerEl,
            filterPeers(peersForDeviceList(latest.peers), peerSearchQuery),
            latest.supportsPingPeer,
            advancedSectionOpen,
          );
        }
      }
    });
    searchContainer.appendChild(searchInput);
    view.appendChild(searchContainer);
  }

  const peerContainer = document.createElement("div");
  peerContainer.className = "peer-container";
  renderPeerList(peerContainer, filteredPeers, state.supportsPingPeer, advancedSectionOpen);
  view.appendChild(peerContainer);

  const footer = document.createElement("div");
  footer.className = "footer";

  if (state.hostVersion) {
    const hostVer = document.createElement("div");
    hostVer.className = "footer-host-version";
    hostVer.textContent = `Native helper ${state.hostVersion}`;
    footer.appendChild(hostVer);
  }

  const diagRow = document.createElement("div");
  diagRow.className = "footer-diagnostics";
  fillFooterDiagnostics(diagRow, state);
  footer.appendChild(diagRow);

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

  footer.appendChild(adminLink);
  footer.appendChild(sep1);
  footer.appendChild(logoutLink);

  const githubCta = document.createElement("div");
  githubCta.className = "footer-github-cta";
  const githubLine = document.createElement("p");
  githubLine.className = "footer-github-cta-line";
  const starLink = document.createElement("a");
  starLink.className = "footer-github-cta-link";
  starLink.href = "#";
  starLink.textContent = "Star the repo!";
  starLink.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: TAILCHROME_PROJECT_URL });
  });
  githubLine.appendChild(starLink);
  githubCta.appendChild(githubLine);
  footer.appendChild(githubCta);

  view.appendChild(footer);

  root.appendChild(view);
}

// Track health key to detect changes during in-place updates
let lastHealthKey = "";

function fillFooterDiagnostics(diagRow: HTMLElement, state: TailscaleState): void {
  diagRow.replaceChildren();
  const diagLink = document.createElement("a");
  diagLink.className = "footer-link";
  diagLink.href = "#";
  diagLink.textContent = "Diagnostics";
  diagLink.title = "Send anonymized diagnostics to Tailscale";
  diagLink.addEventListener("click", (e) => {
    e.preventDefault();
    sendMessage({ type: "bug-report" });
  });
  diagRow.appendChild(diagLink);
}

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

  const statusBarEl = view.querySelector<HTMLElement>(".status-bar");
  const keyExpiry = state.selfNode?.keyExpiry;
  let keyExpEl = view.querySelector<HTMLElement>(".status-bar-keyexpiry");
  if (keyExpiry) {
    const nextText = `Node key expires: ${formatKeyExpiryLocal(keyExpiry)}`;
    if (!keyExpEl && statusBarEl) {
      keyExpEl = document.createElement("div");
      keyExpEl.className = "status-bar-row status-bar-keyexpiry";
      statusBarEl.appendChild(keyExpEl);
    }
    if (keyExpEl && keyExpEl.textContent !== nextText) {
      keyExpEl.textContent = nextText;
    }
  } else if (keyExpEl) {
    keyExpEl.remove();
  }

  const hostFoot = view.querySelector(".footer-host-version");
  if (hostFoot && state.hostVersion) {
    hostFoot.textContent = `Native helper ${state.hostVersion}`;
  }

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

    const prefInputs = quickSettings.querySelectorAll<HTMLInputElement>(
      "input.quick-settings-pref",
    );
    if (prefInputs.length >= 3) {
      const shieldsUp = state.prefs?.shieldsUp ?? false;
      if (prefInputs[0]!.checked !== shieldsUp) {
        prefInputs[0]!.checked = shieldsUp;
      }
      const corpDNS = state.prefs?.corpDNS ?? true;
      if (prefInputs[1]!.checked !== corpDNS) {
        prefInputs[1]!.checked = corpDNS;
      }
      const advertisingExit = state.prefs?.advertiseExitNode ?? false;
      if (prefInputs[2]!.checked !== advertisingExit) {
        prefInputs[2]!.checked = advertisingExit;
      }
    }

    const routesTa = view.querySelector<HTMLTextAreaElement>(".advertise-routes-input");
    if (routesTa && document.activeElement !== routesTa) {
      const next = (state.prefs?.advertiseRoutes ?? []).join(", ");
      if (routesTa.value !== next) {
        routesTa.value = next;
      }
    }
  }

  const peerContainer = view.querySelector<HTMLElement>(".peer-container");
  if (peerContainer) {
    updatePeerList(
      peerContainer,
      filterPeers(peersForDeviceList(state.peers), peerSearchQuery),
      state.supportsPingPeer,
      advancedSectionOpen,
    );
  }
}