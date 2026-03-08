import { copyToClipboard, showToast, detectPlatform } from "../utils";

/**
 * Renders the native host not-installed view.
 * Shows a download button and a simple run command (no curl, no extension ID needed).
 */
export function renderNeedsInstall(root: HTMLElement): void {
  root.textContent = "";
  const view = document.createElement("div");
  view.className = "view";

  // Centered content
  const content = document.createElement("div");
  content.className = "centered-view";

  const icon = document.createElement("div");
  icon.className = "centered-view-icon";
  icon.textContent = "\u26A0\uFE0F"; // warning sign

  const title = document.createElement("h2");
  title.className = "centered-view-title";
  title.textContent = "Setup Required";

  const description = document.createElement("p");
  description.className = "centered-view-text";
  description.textContent =
    "Tailscale needs a helper program to connect your browser to your tailnet.";

  content.appendChild(icon);
  content.appendChild(title);
  content.appendChild(description);

  // Download button
  const platform = detectPlatform();
  const downloadURL = buildDownloadURL(platform);

  const downloadBtn = document.createElement("a");
  downloadBtn.className = "btn btn-primary btn-lg";
  downloadBtn.textContent = "Download Helper";
  downloadBtn.href = downloadURL;
  downloadBtn.target = "_blank";
  downloadBtn.rel = "noopener";
  downloadBtn.style.textDecoration = "none";
  downloadBtn.style.display = "inline-block";
  downloadBtn.style.textAlign = "center";
  content.appendChild(downloadBtn);

  // Run instruction
  const runCmd = buildRunCommand(platform);
  if (runCmd) {
    const stepText = document.createElement("p");
    stepText.className = "centered-view-text";
    stepText.style.marginBottom = "var(--space-xs)";
    stepText.textContent = "Then run it to complete setup:";
    content.appendChild(stepText);

    const codeBlock = document.createElement("div");
    codeBlock.className = "code-block";

    const code = document.createElement("code");
    code.textContent = runCmd;
    codeBlock.appendChild(code);

    // Copy button inside the code block
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn btn-ghost code-block-copy";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => {
      copyToClipboard(runCmd);
      showToast("Command copied to clipboard");
      copyBtn.textContent = "Copied!";
      setTimeout(() => {
        copyBtn.textContent = "Copy";
      }, 2000);
    });
    codeBlock.appendChild(copyBtn);
    content.appendChild(codeBlock);
  }

  view.appendChild(content);
  root.appendChild(view);
}

const RELEASE_BASE =
  "https://github.com/dantraynor/tailchrome/releases/latest/download";

/**
 * Returns the download URL for the native host binary for the detected platform.
 */
function buildDownloadURL(
  platform: "macos" | "linux" | "windows" | "unknown",
): string {
  if (platform === "windows") {
    return `${RELEASE_BASE}/tailscale-browser-ext-windows-amd64.exe`;
  }
  if (platform === "linux") {
    return `${RELEASE_BASE}/tailscale-browser-ext-linux-amd64`;
  }
  // macOS: detect arm64 vs amd64 via navigator
  const arch = isAppleSilicon() ? "arm64" : "amd64";
  return `${RELEASE_BASE}/tailscale-browser-ext-darwin-${arch}`;
}

/**
 * Returns the simple terminal command to run after downloading.
 * The binary auto-installs with the hardcoded extension ID — no flags needed.
 */
function buildRunCommand(
  platform: "macos" | "linux" | "windows" | "unknown",
): string {
  if (platform === "windows") {
    return `.\\tailscale-browser-ext-windows-amd64.exe`;
  }
  // macOS/Linux: need chmod +x since browser downloads don't preserve exec bit
  return `chmod +x ~/Downloads/tailscale-browser-ext* && ~/Downloads/tailscale-browser-ext*`;
}

/**
 * Detects Apple Silicon (ARM) vs Intel Mac.
 */
function isAppleSilicon(): boolean {
  // WebGL renderer often contains "Apple M" on Apple Silicon
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl");
    if (gl) {
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      if (debugInfo) {
        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        if (renderer && typeof renderer === "string") {
          return renderer.includes("Apple M") || renderer.includes("Apple GPU");
        }
      }
    }
  } catch {
    // Fall through to default
  }
  return false; // Default to amd64 if can't detect
}
