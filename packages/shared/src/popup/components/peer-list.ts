import type { PeerInfo } from "../../types";
import { addListKeyboardNav } from "../utils";
import { createPeerItem, peerDisplayKey, updatePeerItemText } from "./peer-item";
import { iconSearch } from "../icons";

/**
 * Filters peers by a search query, matching hostname, DNS name, and IP.
 */
export function filterPeers(peers: PeerInfo[], query: string): PeerInfo[] {
  if (!query) return peers;
  const lower = query.toLowerCase();
  return peers.filter((p) =>
    p.hostname.toLowerCase().includes(lower) ||
    (p.dnsName && p.dnsName.toLowerCase().includes(lower)) ||
    p.tailscaleIPs.some((ip) => ip.includes(lower))
  );
}

/**
 * Creates a section header element with label and optional count.
 */
function createSectionHeader(label: string, count: number): HTMLElement {
  const header = document.createElement("div");
  header.className = "section-header";

  const labelEl = document.createElement("span");
  labelEl.className = "section-header-label";
  labelEl.textContent = label;

  const countEl = document.createElement("span");
  countEl.className = "section-header-count";
  countEl.textContent = String(count);

  header.appendChild(labelEl);
  header.appendChild(countEl);
  return header;
}

function renderEmptyState(container: HTMLElement): void {
  const empty = document.createElement("div");
  empty.className = "empty-state";

  const icon = document.createElement("div");
  icon.className = "empty-state-icon icon icon-xl";
  icon.appendChild(iconSearch());

  const title = document.createElement("div");
  title.className = "empty-state-title";
  title.textContent = "No devices found";

  const text = document.createElement("div");
  text.className = "empty-state-text";
  text.textContent = "Other devices on your tailnet will appear here once they come online.";

  empty.appendChild(icon);
  empty.appendChild(title);
  empty.appendChild(text);
  container.appendChild(empty);
}

/**
 * Renders a peer section (header + list of peer items) into the container.
 * Reuses existing peer item elements from cachedElements where possible.
 */
function renderPeerSection(
  container: HTMLElement,
  label: string,
  peers: PeerInfo[],
  cachedElements: Map<string, HTMLElement>,
  supportsPingPeer: boolean,
  showPeerSSH: boolean,
): void {
  const pingCap = supportsPingPeer ? "1" : "0";
  const sshCap = showPeerSSH ? "1" : "0";
  container.appendChild(createSectionHeader(label, peers.length));
  const list = document.createElement("div");
  list.className = "peer-list";
  for (const peer of peers) {
    let cached = cachedElements.get(peer.id);
    if (cached && cached.dataset.hostPingCap !== pingCap) {
      cached = undefined;
    }
    if (cached && cached.dataset.showPeerSsh !== sshCap) {
      cached = undefined;
    }
    if (cached) {
      const oldKey = cached.dataset.displayKey;
      const newKey = peerDisplayKey(peer);
      if (oldKey !== newKey) {
        updatePeerItemText(cached, peer);
      }
      list.appendChild(cached);
    } else {
      list.appendChild(createPeerItem(peer, supportsPingPeer, showPeerSSH));
    }
  }
  container.appendChild(list);
}

/**
 * Renders the peer list, grouped by online/offline status.
 * Online peers appear first, followed by offline peers.
 */
export function renderPeerList(
  container: HTMLElement,
  peers: PeerInfo[],
  supportsPingPeer: boolean,
  showPeerSSH: boolean,
): void {
  if (!container.dataset.kbnav) {
    addListKeyboardNav(container, ".peer-item");
    container.dataset.kbnav = "1";
  }
  container.textContent = "";

  if (peers.length === 0) {
    renderEmptyState(container);
    return;
  }

  const online = peers.filter((p) => p.online);
  const offline = peers.filter((p) => !p.online);

  // Online section
  if (online.length > 0) {
    container.appendChild(createSectionHeader("Online", online.length));
    const list = document.createElement("div");
    list.className = "peer-list";
    for (const peer of online) {
      list.appendChild(createPeerItem(peer, supportsPingPeer, showPeerSSH));
    }
    container.appendChild(list);
  }

  // Offline section
  if (offline.length > 0) {
    container.appendChild(createSectionHeader("Offline", offline.length));
    const list = document.createElement("div");
    list.className = "peer-list";
    for (const peer of offline) {
      list.appendChild(createPeerItem(peer, supportsPingPeer, showPeerSSH));
    }
    container.appendChild(list);
  }
}

/**
 * Incrementally updates the peer list, reusing existing DOM elements
 * to preserve expanded/collapsed state and avoid animation replays.
 */
export function updatePeerList(
  container: HTMLElement,
  peers: PeerInfo[],
  supportsPingPeer: boolean,
  showPeerSSH: boolean,
): void {
  // Collect existing peer item elements by ID
  const cachedElements = new Map<string, HTMLElement>();
  for (const el of container.querySelectorAll<HTMLElement>(".peer-item-container[data-peer-id]")) {
    cachedElements.set(el.dataset.peerId!, el);
  }

  container.textContent = "";

  if (peers.length === 0) {
    renderEmptyState(container);
    return;
  }

  const online = peers.filter((p) => p.online);
  const offline = peers.filter((p) => !p.online);

  if (online.length > 0) {
    renderPeerSection(container, "Online", online, cachedElements, supportsPingPeer, showPeerSSH);
  }
  if (offline.length > 0) {
    renderPeerSection(container, "Offline", offline, cachedElements, supportsPingPeer, showPeerSSH);
  }
}
