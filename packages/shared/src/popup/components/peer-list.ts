import type { PeerInfo } from "../../types";
import { addListKeyboardNav } from "../utils";
import { createPeerItem, peerActionsKey, peerDisplayKey, updatePeerItemText } from "./peer-item";
import { iconSearch } from "../icons";

const PREVIEW_LIMIT = 5;
// The owner can outlive a list container replaced during a view redraw.
const expandedLists = new WeakSet<HTMLElement>();

/**
 * Filters peers by a search query, matching hostname, DNS name, and IP.
 */
export function filterPeers(peers: PeerInfo[], query: string): PeerInfo[] {
  const lower = query.trim().toLowerCase();
  if (!lower) return peers;
  return peers.filter((p) =>
    p.hostname.toLowerCase().includes(lower) ||
    (p.dnsName && p.dnsName.toLowerCase().includes(lower)) ||
    p.tailscaleIPs.some((ip) => ip.toLowerCase().includes(lower))
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

function renderEmptyState(container: HTMLElement, searching: boolean): void {
  const empty = document.createElement("div");
  empty.className = "empty-state";

  const icon = document.createElement("div");
  icon.className = "empty-state-icon icon icon-xl";
  icon.appendChild(iconSearch());

  const title = document.createElement("div");
  title.className = "empty-state-title";
  title.textContent = searching ? "No matching devices" : "No devices found";

  const text = document.createElement("div");
  text.className = "empty-state-text";
  text.textContent = searching
    ? "Try another name or IP address."
    : "Other devices on your tailnet will appear here once they come online.";

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
      const oldKey = cached.dataset.displayKey ?? "";
      const newKey = peerDisplayKey(peer);
      const oldActions = cached.dataset.actionsKey ?? "";
      const newActions = peerActionsKey(peer, supportsPingPeer, showPeerSSH);

      if (oldKey === newKey && oldActions === newActions) {
        list.appendChild(cached);
      } else if (oldKey !== newKey && oldActions === newActions) {
        updatePeerItemText(cached, peer);
        list.appendChild(cached);
      } else {
        list.appendChild(createPeerItem(peer, supportsPingPeer, showPeerSSH));
      }
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
  query = "",
  expansionOwner: HTMLElement = container,
): void {
  if (!container.dataset.kbnav) {
    addListKeyboardNav(container, ".peer-item");
    container.dataset.kbnav = "1";
  }
  container.textContent = "";

  updatePeerList(container, peers, supportsPingPeer, showPeerSSH, query, expansionOwner);
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
  query = "",
  expansionOwner: HTMLElement = container,
): void {
  const focused = container.contains(document.activeElement)
    ? document.activeElement as HTMLElement
    : null;
  // Collect existing peer item elements by ID
  const cachedElements = new Map<string, HTMLElement>();
  for (const el of container.querySelectorAll<HTMLElement>(".peer-item-container[data-peer-id]")) {
    cachedElements.set(el.dataset.peerId!, el);
  }

  container.textContent = "";

  const searching = query.trim().length > 0;
  const matches = filterPeers(peers, query);
  if (matches.length === 0) {
    renderEmptyState(container, searching);
    return;
  }

  const ordered = [
    ...matches.filter((p) => p.online),
    ...matches.filter((p) => !p.online),
  ];
  const expanded = expandedLists.has(expansionOwner);
  const visible = searching || expanded ? ordered : ordered.slice(0, PREVIEW_LIMIT);
  const online = visible.filter((p) => p.online);
  const offline = visible.filter((p) => !p.online);

  if (online.length > 0) {
    renderPeerSection(container, "Online", online, cachedElements, supportsPingPeer, showPeerSSH);
  }
  if (offline.length > 0) {
    renderPeerSection(container, "Offline", offline, cachedElements, supportsPingPeer, showPeerSSH);
  }

  if (!searching && matches.length > PREVIEW_LIMIT) {
    const more = document.createElement("div");
    more.className = "peer-list-more";
    const count = document.createElement("span");
    count.textContent = `Showing ${visible.length} of ${matches.length} devices`;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "peer-list-toggle";
    toggle.textContent = expanded ? "Show fewer" : "View all";
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.addEventListener("click", () => {
      if (expanded) expandedLists.delete(expansionOwner);
      else expandedLists.add(expansionOwner);
      updatePeerList(container, peers, supportsPingPeer, showPeerSSH, query, expansionOwner);
      container.querySelector<HTMLButtonElement>(".peer-list-toggle")?.focus();
    });
    more.append(count, toggle);
    container.appendChild(more);
  }

  // Reattaching a cached row must not interrupt keyboard interaction.
  if (focused && container.contains(focused)) focused.focus({ preventScroll: true });
  else if (focused?.classList.contains("peer-list-toggle")) {
    container.querySelector<HTMLButtonElement>(".peer-list-toggle")?.focus({ preventScroll: true });
  }
}
