import type { PeerInfo } from "../../shared/types";
import { createPeerItem, type PeerItemOptions } from "./peer-item";

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

/**
 * Renders the peer list, grouped by online/offline status.
 * Online peers appear first, followed by offline peers.
 */
export function renderPeerList(container: HTMLElement, peers: PeerInfo[], options: PeerItemOptions = {}): void {
  container.textContent = "";

  if (peers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";

    const icon = document.createElement("div");
    icon.className = "empty-state-icon";
    icon.textContent = "\uD83D\uDD0D"; // magnifying glass

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
      list.appendChild(createPeerItem(peer, options));
    }
    container.appendChild(list);
  }

  // Offline section
  if (offline.length > 0) {
    container.appendChild(createSectionHeader("Offline", offline.length));
    const list = document.createElement("div");
    list.className = "peer-list";
    for (const peer of offline) {
      list.appendChild(createPeerItem(peer, options));
    }
    container.appendChild(list);
  }
}
