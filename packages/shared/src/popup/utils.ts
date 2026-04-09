/**
 * Escapes HTML special characters to prevent XSS when inserting user content.
 */
export function escapeHTML(str: string): string {
  const div = document.createElement("div");
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

/**
 * Copies text to the clipboard using the Clipboard API.
 */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for contexts where clipboard API is unavailable
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }
}

interface ToastOptions {
  level?: "info" | "error";
  /** If true, the toast stays visible until replaced by another toast. */
  persistent?: boolean;
  /** When not persistent, remove after this many ms (default 2500). */
  dismissMs?: number;
  /** Preserve line breaks (e.g. diagnostics reference + URL). */
  multiline?: boolean;
}

/**
 * Shows a toast notification at the bottom of the popup.
 * By default, auto-dismisses after 2.5s (override with `dismissMs`). Pass persistent: true to keep until replaced.
 */
export function showToast(message: string, levelOrOptions: "info" | "error" | ToastOptions = "info"): void {
  const opts: ToastOptions = typeof levelOrOptions === "string"
    ? { level: levelOrOptions }
    : levelOrOptions;
  const level = opts.level ?? "info";
  const persistent = opts.persistent ?? false;
  const dismissMs = opts.dismissMs ?? 2500;
  const multiline = opts.multiline ?? false;

  // Remove any existing toast
  const existing = document.querySelector(".toast");
  if (existing) {
    existing.remove();
  }

  const toast = document.createElement("div");
  toast.className = "toast"
    + (level === "error" ? " toast-error" : "")
    + (persistent ? " toast-persistent" : "")
    + (multiline ? " toast-multiline" : "");
  toast.textContent = message;
  // Match --transition-normal (200ms) so toastOut finishes when the element is removed.
  const toastAnimMs = 200;
  if (!persistent) {
    toast.style.setProperty(
      "--toast-exit-delay",
      `${Math.max(0, dismissMs - toastAnimMs)}ms`,
    );
  }
  document.body.appendChild(toast);

  if (!persistent) {
    setTimeout(() => {
      toast.remove();
    }, dismissMs);
  }
}

/**
 * Creates a copy button (small clipboard icon) that copies the given text.
 */
export function createCopyButton(textToCopy: string): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "copy-btn";
  btn.title = "Copy to clipboard";
  btn.setAttribute("aria-label", "Copy to clipboard");

  // Clipboard icon using SVG (via DOM API, no innerHTML)
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  // Outer clipboard rectangle
  const rect1 = document.createElementNS(ns, "rect");
  rect1.setAttribute("x", "5");
  rect1.setAttribute("y", "5");
  rect1.setAttribute("width", "8");
  rect1.setAttribute("height", "9");
  rect1.setAttribute("rx", "1.5");

  // Back rectangle (the copy source)
  const rect2 = document.createElementNS(ns, "rect");
  rect2.setAttribute("x", "3");
  rect2.setAttribute("y", "2");
  rect2.setAttribute("width", "8");
  rect2.setAttribute("height", "9");
  rect2.setAttribute("rx", "1.5");

  svg.appendChild(rect2);
  svg.appendChild(rect1);
  btn.appendChild(svg);

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    copyToClipboard(textToCopy);
    btn.classList.add("copied");
    showToast("Copied " + textToCopy);
    setTimeout(() => {
      btn.classList.remove("copied");
    }, 1500);
  });

  return btn;
}

/**
 * Adds arrow-key navigation to a container of focusable items.
 * ArrowDown/ArrowUp moves focus between items matching the given selector.
 */
export function addListKeyboardNav(container: HTMLElement, itemSelector: string): void {
  container.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(container.querySelectorAll<HTMLElement>(itemSelector));
    if (items.length === 0) return;
    const current = document.activeElement as HTMLElement | null;
    const idx = current ? items.indexOf(current) : -1;
    let next: number;
    if (e.key === "ArrowDown") {
      next = idx < items.length - 1 ? idx + 1 : 0;
    } else {
      next = idx > 0 ? idx - 1 : items.length - 1;
    }
    e.preventDefault();
    items[next]!.focus();
  });
}

/**
 * Detects the user's platform for platform-specific instructions.
 */
export function detectPlatform(): "macos" | "linux" | "windows" | "unknown" {
  // Try modern API first
  const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform ?? navigator.platform ?? "";
  const lower = platform.toLowerCase();

  if (lower.includes("mac")) return "macos";
  if (lower.includes("win")) return "windows";
  if (lower.includes("linux")) return "linux";
  return "unknown";
}

/** Human-readable byte size (rx/tx stats). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

/** Format RFC3339 key expiry for display. */
export function formatKeyExpiryLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
