import type { PeerInfo } from "../../types";
import { copyToClipboard, formatBytes, showToast } from "../utils";
import { sendMessage } from "../popup";
import { getCustomUrl, setCustomUrl, clearCustomUrl, resolveOpenUrl } from "../custom-urls";
import { iconForOS } from "../icons";

/**
 * Format an ISO date string as a relative time like "2m ago" or "3h ago".
 * Returns "offline" if the date is null or too old.
 */
export function formatRelativeTime(isoDate: string | null): string {
  if (!isoDate) return "offline";

  const now = Date.now();
  const then = new Date(isoDate).getTime();
  if (isNaN(then)) return "offline";

  const diffMs = now - then;
  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  return "long ago";
}

/**
 * Returns a string key representing the displayed fields of a peer.
 * Used to detect whether a peer item needs updating.
 */
export function peerDisplayKey(peer: PeerInfo): string {
  return `${peer.hostname}|${peer.online}|${peer.tailscaleIPs[0] ?? ""}|${peer.lastSeen ?? ""}|${peer.exitNode}|${peer.dnsName}|${peer.rxBytes}|${peer.txBytes}|${peer.lastHandshake ?? ""}|${(peer.tags ?? []).join(",")}|${peer.userLoginName}|${peer.userName}|${peer.sshHost ?? ""}`;
}

/**
 * Updates the visible text content of an existing peer item container in place.
 * Preserves expansion state and event listeners.
 */
export function updatePeerItemText(container: HTMLElement, peer: PeerInfo): void {
  const nameEl = container.querySelector(".peer-name");
  if (nameEl) nameEl.textContent = peer.hostname;

  const metaEl = container.querySelector(".peer-meta");
  if (metaEl) {
    const dot = metaEl.querySelector(".status-dot");
    if (dot) dot.className = "status-dot " + (peer.online ? "online" : "offline");
    // Update the text node after the dot
    const textSpan = metaEl.querySelectorAll("span");
    if (textSpan.length >= 2) {
      textSpan[1]!.textContent = peer.online ? "online" : formatRelativeTime(peer.lastSeen);
    }
  }

  const ipEl = container.querySelector(".peer-ip");
  if (ipEl) {
    const firstIP = peer.tailscaleIPs[0];
    ipEl.textContent = firstIP ?? "";
  }

  const det = container.querySelector(".peer-details");
  if (det) {
    det.textContent = buildPeerDetailsText(peer);
  }

  container.dataset.displayKey = peerDisplayKey(peer);
  container.dataset.sshActionShown =
    container.dataset.showPeerSsh === "1" && peer.sshHost && peer.online ? "1" : "0";
}

function buildPeerDetailsText(peer: PeerInfo): string {
  const parts: string[] = [
    `\u2193 ${formatBytes(peer.rxBytes)} \u00b7 \u2191 ${formatBytes(peer.txBytes)}`,
  ];
  if (peer.lastHandshake) {
    parts.push(`Handshake ${formatRelativeTime(peer.lastHandshake)}`);
  }
  if (peer.tags?.length) {
    parts.push(peer.tags.join(" "));
  }
  if (peer.userLoginName) {
    parts.push(peer.userLoginName);
  } else if (peer.userName) {
    parts.push(peer.userName);
  }
  return parts.join(" \u00b7 ");
}

/**
 * Creates a single peer item row element with expandable actions.
 */
export function createPeerItem(
  peer: PeerInfo,
  supportsPingPeer: boolean,
  showPeerSSH: boolean,
): HTMLElement {
  const container = document.createElement("div");
  container.className = "peer-item-container";
  container.dataset.peerId = peer.id;
  container.dataset.hostPingCap = supportsPingPeer ? "1" : "0";
  container.dataset.showPeerSsh = showPeerSSH ? "1" : "0";
  container.dataset.sshActionShown = showPeerSSH && peer.sshHost && peer.online ? "1" : "0";
  container.dataset.displayKey = peerDisplayKey(peer);

  const row = document.createElement("div");
  row.className = "peer-item";
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "0");
  row.setAttribute("aria-label", `${peer.hostname}, ${peer.online ? "online" : "offline"}`);

  // OS icon
  const icon = document.createElement("div");
  icon.className = "peer-icon";
  const iconEl = document.createElement("span");
  iconEl.className = "icon";
  iconEl.appendChild(iconForOS(peer.os));
  icon.appendChild(iconEl);

  // Info column
  const info = document.createElement("div");
  info.className = "peer-info";

  const name = document.createElement("div");
  name.className = "peer-name";
  name.textContent = peer.hostname;

  const meta = document.createElement("div");
  meta.className = "peer-meta";

  const dot = document.createElement("span");
  dot.className = "status-dot " + (peer.online ? "online" : "offline");
  meta.appendChild(dot);

  const lastSeen = document.createElement("span");
  lastSeen.textContent = peer.online ? "online" : formatRelativeTime(peer.lastSeen);
  meta.appendChild(lastSeen);

  if (peer.exitNode) {
    const exitLabel = document.createElement("span");
    exitLabel.className = "peer-exit-label";
    exitLabel.textContent = " \u2022 exit node";
    meta.appendChild(exitLabel);
  }

  info.appendChild(name);
  info.appendChild(meta);

  // Address display
  const ip = document.createElement("div");
  ip.className = "peer-ip";
  const firstIP = peer.tailscaleIPs[0];
  const shortDNS = peer.dnsName ? peer.dnsName.replace(/\.$/, "") : "";
  ip.textContent = firstIP ?? "";

  row.appendChild(icon);
  row.appendChild(info);
  row.appendChild(ip);

  // Actions panel (hidden by default)
  const actions = document.createElement("div");
  actions.className = "peer-actions";

  const details = document.createElement("div");
  details.className = "peer-details";
  details.textContent = buildPeerDetailsText(peer);
  actions.appendChild(details);

  if (firstIP) {
    actions.appendChild(createActionButton("Copy IP", () => {
      copyToClipboard(firstIP);
      showToast("Copied " + firstIP);
    }));
  }

  if (peer.dnsName) {
    const shortDNS = peer.dnsName.replace(/\.$/, "");
    actions.appendChild(createActionButton("Copy DNS", () => {
      copyToClipboard(shortDNS);
      showToast("Copied " + shortDNS);
    }));
  }

  // Track openTarget for use in custom URL editor
  let openTarget: string | undefined;
  let openBtn: HTMLElement | null = null;

  if (peer.online) {
    openTarget = shortDNS || firstIP || undefined;
    if (openTarget) {
      openBtn = createActionButton(openButtonLabel(getCustomUrl(peer.id)), () => {
        chrome.tabs.create({ url: resolveOpenUrl(openTarget!, getCustomUrl(peer.id)) });
      });
      actions.appendChild(openBtn);
    }
  }

  if (supportsPingPeer && peer.online && firstIP) {
    actions.appendChild(createActionButton("Ping", () => {
      sendMessage({ type: "ping-peer", nodeID: peer.id });
      showToast(`Pinging ${peer.hostname}\u2026`, "info");
    }));
  }

  if (showPeerSSH && peer.sshHost && peer.online) {
    actions.appendChild(createActionButton("SSH", () => {
      chrome.tabs.create({ url: `http://100.100.100.100/ssh/${peer.hostname}` });
    }));
  }

  if (peer.taildropTarget && peer.online) {
    actions.appendChild(createActionButton("Send File", () => {
      openFilePicker(peer);
    }));
  }

  // Custom URL editor (inline, hidden by default)
  let editRow: HTMLElement | null = null;
  if (peer.online && openTarget) {
    const existingUrl = getCustomUrl(peer.id) || "";

    editRow = document.createElement("div");
    editRow.className = "peer-url-edit";
    editRow.style.display = "none";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "peer-url-input";
    input.placeholder = "port or full URL";
    input.value = existingUrl;

    const clearBtn = document.createElement("button");
    clearBtn.className = "peer-action-btn";
    clearBtn.textContent = "Clear";
    clearBtn.style.display = existingUrl ? "" : "none";
    clearBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await clearCustomUrl(peer.id);
      input.value = "";
      clearBtn.style.display = "none";
      if (openBtn) openBtn.textContent = openButtonLabel(undefined);
      showToast(`Custom URL cleared for ${peer.hostname}`);
    });

    const saveBtn = document.createElement("button");
    saveBtn.className = "peer-action-btn";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const val = input.value.trim();
      if (val) {
        await setCustomUrl(peer.id, val);
        clearBtn.style.display = "";
        if (openBtn) openBtn.textContent = openButtonLabel(val);
        showToast(`Custom URL saved for ${peer.hostname}`);
      }
    });

    editRow.appendChild(input);
    editRow.appendChild(saveBtn);
    editRow.appendChild(clearBtn);

    actions.appendChild(createActionButton("Set URL", () => {
      if (editRow) {
        editRow.style.display = editRow.style.display === "none" ? "flex" : "none";
        if (editRow.style.display === "flex") input.focus();
      }
    }));
  }

  // Toggle actions on click or Enter/Space
  const toggleActions = () => {
    const isOpen = container.classList.toggle("peer-item-container--expanded");
    actions.style.display = isOpen ? "flex" : "none";
    if (!isOpen && editRow) editRow.style.display = "none";
    row.setAttribute("aria-expanded", String(isOpen));
  };
  row.addEventListener("click", toggleActions);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleActions();
    }
  });

  actions.style.display = "none";
  container.appendChild(row);
  container.appendChild(actions);
  if (editRow) container.appendChild(editRow);

  return container;
}

function openButtonLabel(customValue: string | undefined): string {
  if (!customValue) return "Open";
  return /^\d+$/.test(customValue) ? `Open :${customValue}` : "Open (custom)";
}

function createActionButton(label: string, onClick: () => void): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "peer-action-btn";
  btn.textContent = label;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

const FILE_CHUNK_BYTES = 700_000;
const MAX_SEND_FILE_SIZE = 50 * 1024 * 1024; // must match host maxAssembledFileSize

function uint8ToBase64(u8: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      u8.subarray(i, i + chunk) as unknown as number[],
    );
  }
  return btoa(binary);
}

function openFilePicker(peer: PeerInfo): void {
  const input = document.createElement("input");
  input.type = "file";
  input.style.display = "none";
  document.body.appendChild(input);

  const cleanup = () => {
    if (input.parentNode) {
      document.body.removeChild(input);
    }
  };

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) {
      cleanup();
      return;
    }

    if (file.size > MAX_SEND_FILE_SIZE) {
      showToast(
        `File too large (${Math.round(file.size / 1024 / 1024)} MB). Maximum is ${MAX_SEND_FILE_SIZE / 1024 / 1024} MB.`,
        "error",
      );
      cleanup();
      return;
    }

    if (file.size <= FILE_CHUNK_BYTES) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const commaIndex = result.indexOf(",");
        const base64 = commaIndex >= 0 ? result.slice(commaIndex + 1) : result;
        sendMessage({
          type: "send-file",
          targetNodeID: peer.id,
          name: file.name,
          size: file.size,
          dataBase64: base64,
        });
        showToast(`Sending "${file.name}" to ${peer.hostname}...`);
      };
      reader.onerror = () => {
        showToast("Failed to read file", "error");
      };
      reader.readAsDataURL(file);
    } else {
      void sendFileChunked(peer, file);
    }
    cleanup();
  });

  input.addEventListener("cancel", cleanup);

  input.click();
}

async function sendFileChunked(peer: PeerInfo, file: File): Promise<void> {
  const transferID = crypto.randomUUID();
  const chunkCount = Math.ceil(file.size / FILE_CHUNK_BYTES);
  showToast(`Sending "${file.name}" in ${chunkCount} parts...`, "info");
  try {
    for (let i = 0; i < chunkCount; i++) {
      const slice = file.slice(i * FILE_CHUNK_BYTES, (i + 1) * FILE_CHUNK_BYTES);
      const buf = await slice.arrayBuffer();
      const base64 = uint8ToBase64(new Uint8Array(buf));
      sendMessage({
        type: "send-file",
        targetNodeID: peer.id,
        name: file.name,
        size: file.size,
        dataBase64: base64,
        transferID,
        chunkIndex: i,
        chunkCount,
      });
    }
  } catch {
    showToast("Failed to read file", "error");
  }
}
