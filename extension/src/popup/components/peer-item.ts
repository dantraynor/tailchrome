import type { PeerInfo } from "../../shared/types";
import { escapeHTML, copyToClipboard, showToast } from "../utils";
import { sendMessage } from "../popup";

/** Map OS strings to emoji icons. */
function osIcon(os: string): string {
  const lower = os.toLowerCase();
  if (lower.includes("macos") || lower.includes("darwin")) return "\uD83D\uDCBB"; // laptop
  if (lower.includes("linux")) return "\uD83D\uDDA5\uFE0F"; // desktop
  if (lower.includes("windows")) return "\uD83E\uDE9F"; // window
  if (lower.includes("ios") || lower.includes("iphone") || lower.includes("ipad")) return "\uD83D\uDCF1"; // mobile
  if (lower.includes("android")) return "\uD83D\uDCF1"; // mobile
  if (lower.includes("freebsd") || lower.includes("openbsd")) return "\uD83D\uDDA5\uFE0F"; // desktop
  return "\uD83D\uDCBB"; // default laptop
}

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

export interface PeerItemOptions {
  /** When true, MagicDNS is enabled and DNS names can be used to reach peers. */
  magicDNS?: boolean;
}

/**
 * Creates a single peer item row element with expandable actions.
 */
export function createPeerItem(peer: PeerInfo, options: PeerItemOptions = {}): HTMLElement {
  const container = document.createElement("div");
  container.className = "peer-item-container";

  const row = document.createElement("div");
  row.className = "peer-item";
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "0");
  row.setAttribute("aria-label", `${peer.hostname}, ${peer.online ? "online" : "offline"}`);

  // OS icon
  const icon = document.createElement("div");
  icon.className = "peer-icon";
  icon.textContent = osIcon(peer.os);

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
    exitLabel.textContent = " \u2022 exit node";
    exitLabel.style.color = "var(--ts-blue)";
    meta.appendChild(exitLabel);
  }

  info.appendChild(name);
  info.appendChild(meta);

  // Address display
  const ip = document.createElement("div");
  ip.className = "peer-ip";
  const firstIP = peer.tailscaleIPs[0];
  const shortDNS = peer.dnsName ? peer.dnsName.replace(/\.$/, "") : "";
  ip.textContent = firstIP ? escapeHTML(firstIP) : "";

  row.appendChild(icon);
  row.appendChild(info);
  row.appendChild(ip);

  // Actions panel (hidden by default)
  const actions = document.createElement("div");
  actions.className = "peer-actions";

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

  if (peer.online) {
    const openTarget = (options.magicDNS && shortDNS) || firstIP;
    if (openTarget) {
      actions.appendChild(createActionButton("Open", () => {
        chrome.tabs.create({ url: `http://${openTarget}/` });
      }));
    }
  }

  if (peer.sshHost && peer.online) {
    actions.appendChild(createActionButton("SSH", () => {
      chrome.tabs.create({ url: `http://100.100.100.100/ssh/${peer.hostname}` });
    }));
  }

  if (peer.taildropTarget && peer.online) {
    actions.appendChild(createActionButton("Send File", () => {
      openFilePicker(peer);
    }));
  }

  // Toggle actions on click or Enter/Space
  const toggleActions = () => {
    const isOpen = container.classList.toggle("peer-item-container--expanded");
    actions.style.display = isOpen ? "flex" : "none";
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

  return container;
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

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data URL prefix to get raw base64
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
    cleanup();
  });

  // Clean up if the user cancels the file picker
  input.addEventListener("cancel", cleanup);

  input.click();
}
