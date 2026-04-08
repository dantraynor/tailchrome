import { copyToClipboard, showToast, detectPlatform } from "../utils";
import { EXPECTED_HOST_VERSION } from "../../constants";
import { iconPackage, iconRefresh } from "../icons";

type Platform = "macos" | "linux" | "windows" | "unknown";

const RELEASE_BASE =
  "https://github.com/dantraynor/tailchrome/releases/latest/download";

/**
 * Returns the filename of the native host binary for the detected platform.
 */
export function binaryFilename(platform: Platform): string | null {
  if (platform === "windows") {
    return "tailscale-browser-ext-windows-amd64.exe";
  }
  if (platform === "linux") {
    return "tailscale-browser-ext-linux-amd64";
  }
  if (platform === "macos") {
    const arch = detectArch();
    return `tailscale-browser-ext-darwin-${arch}`;
  }
  return null;
}

/**
 * Returns the download URL for the native host binary for the detected platform.
 * Falls back to the releases page if platform is unknown.
 */
export function buildDownloadURL(platform: Platform): string {
  const filename = binaryFilename(platform);
  if (filename) {
    return `${RELEASE_BASE}/${filename}`;
  }
  return "https://github.com/dantraynor/tailchrome/releases/latest";
}

/**
 * Returns the simple terminal command to run after downloading.
 * The binary auto-installs with the hardcoded extension ID -- no flags needed.
 */
export function buildRunCommand(platform: Platform): string | null {
  const filename = binaryFilename(platform);
  if (!filename) {
    return null;
  }
  if (platform === "windows") {
    return `cd %USERPROFILE%\\Downloads && .\\${filename}`;
  }
  // macOS/Linux: need chmod +x since browser downloads don't preserve exec bit
  return `chmod +x ~/Downloads/${filename} && ~/Downloads/${filename}`;
}

/**
 * Returns a human-readable platform label.
 */
function platformLabel(platform: Platform): string {
  switch (platform) {
    case "macos":
      return "macOS";
    case "windows":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return "your computer";
  }
}

/**
 * Renders the shared install/update flow with platform-adaptive stepper UI.
 */
export function renderInstallFlow(
  root: HTMLElement,
  opts: { mode: "install" | "update"; hostVersion?: string | null },
): void {
  root.textContent = "";
  const view = document.createElement("div");
  view.className = "view";

  const content = document.createElement("div");
  content.className = "centered-view";

  // Icon
  const icon = document.createElement("div");
  icon.className = "centered-view-icon";
  const iconEl = document.createElement("span");
  iconEl.className = "icon icon-2xl";
  iconEl.appendChild(opts.mode === "install" ? iconPackage() : iconRefresh());
  icon.appendChild(iconEl);

  // Title
  const title = document.createElement("h2");
  title.className = "centered-view-title";
  title.textContent = opts.mode === "install" ? "Quick Setup" : "Update Available";

  // Subtitle
  const description = document.createElement("p");
  description.className = "centered-view-text";
  description.textContent =
    opts.mode === "install"
      ? "Tailscale needs a small helper app to connect your browser to your tailnet."
      : "A newer version of the helper app is needed for this extension.";

  content.appendChild(icon);
  content.appendChild(title);
  content.appendChild(description);

  // Version info (update mode only)
  if (opts.mode === "update") {
    const versionInfo = document.createElement("p");
    versionInfo.className = "centered-view-text version-info";
    const currentLabel = opts.hostVersion ?? "unknown";
    versionInfo.textContent = `Installed: ${currentLabel} \u2192 Required: ${EXPECTED_HOST_VERSION}`;
    content.appendChild(versionInfo);
  }

  const platform = detectPlatform();

  if (platform === "macos" && opts.mode === "install") {
    const pkgUrl = `${RELEASE_BASE}/tailchrome-helper-macos.pkg`;
    const cta = document.createElement("div");
    cta.className = "install-pkg-cta";
    const pkgLink = document.createElement("a");
    pkgLink.className = "btn btn-primary btn-link";
    pkgLink.href = pkgUrl;
    pkgLink.rel = "noopener";
    pkgLink.textContent = "Download macOS installer (.pkg)";
    pkgLink.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: pkgUrl });
    });
    cta.appendChild(pkgLink);
    content.appendChild(cta);
    const pkgHint = document.createElement("p");
    pkgHint.className = "centered-view-text install-pkg-hint";
    pkgHint.textContent =
      "Open the downloaded package, then launch Tailchrome Helper from Applications once. Come back here when done.";
    content.appendChild(pkgHint);
  }

  const downloadURL = buildDownloadURL(platform);
  const filename = binaryFilename(platform);
  const runCmd = buildRunCommand(platform);

  // Steps container
  const steps = document.createElement("div");
  steps.className = "install-steps";

  const step1 = createStep("1");
  step1.label.textContent =
    platform === "macos" && opts.mode === "install"
      ? "Alternative: raw binary (advanced)"
      : "Download the helper app";

  const downloadBtn = document.createElement("a");
  downloadBtn.className = "btn btn-primary btn-link";
  downloadBtn.href = downloadURL;
  downloadBtn.target = "_blank";
  downloadBtn.rel = "noopener";

  if (opts.mode === "update") {
    downloadBtn.textContent = "Download Update";
  } else if (platform === "unknown") {
    downloadBtn.textContent = "Download";
  } else {
    downloadBtn.textContent = `Download for ${platformLabel(platform)}`;
  }

  // After clicking download, update button to hint at next step
  downloadBtn.addEventListener("click", () => {
    setTimeout(() => {
      downloadBtn.textContent = "Downloaded? Continue below \u2193";
      downloadBtn.classList.remove("btn-primary");
      downloadBtn.classList.add("btn-secondary");
    }, 500);
  });

  step1.content.appendChild(step1.label);
  step1.content.appendChild(downloadBtn);
  steps.appendChild(step1.root);

  if (platform === "unknown") {
    const step2 = createStep("2");
    step2.label.textContent = "Run the downloaded file";
    const body = document.createElement("div");
    body.className = "install-step-body";
    body.textContent = "Open the downloaded file to complete setup.";
    step2.content.appendChild(step2.label);
    step2.content.appendChild(body);
    steps.appendChild(step2.root);
  } else if (platform === "windows") {
    const step2 = createStep("2");
    step2.label.textContent = "Open the downloaded file";

    const body = document.createElement("div");
    body.className = "install-step-body";
    body.appendChild(document.createTextNode("Find "));
    const strong = document.createElement("strong");
    strong.textContent = filename ?? "the downloaded file";
    body.appendChild(strong);
    body.appendChild(
      document.createTextNode(" in your Downloads folder and double-click it."),
    );

    const hint = document.createElement("div");
    hint.className = "install-step-hint";
    hint.textContent =
      'You can close the window after it says "installed successfully".';

    step2.content.appendChild(step2.label);
    step2.content.appendChild(body);
    step2.content.appendChild(hint);
    steps.appendChild(step2.root);
  } else {
    // macOS / Linux: need terminal
    const step2 = createStep("2");
    step2.label.textContent = "Run the installer";

    const body = document.createElement("div");
    body.className = "install-step-body";

    if (platform === "macos") {
      body.appendChild(document.createTextNode("Open Terminal (press "));
      const kbd1 = document.createElement("strong");
      kbd1.textContent = "Cmd + Space";
      body.appendChild(kbd1);
      body.appendChild(document.createTextNode(", type "));
      const kbd2 = document.createElement("strong");
      kbd2.textContent = "Terminal";
      body.appendChild(kbd2);
      body.appendChild(
        document.createTextNode(", press Enter), then paste this command:"),
      );
    } else {
      body.textContent = "Open a terminal and paste this command:";
    }

    step2.content.appendChild(step2.label);
    step2.content.appendChild(body);

    if (runCmd) {
      step2.content.appendChild(createCodeBlock(runCmd));
    }

    const hint = document.createElement("div");
    hint.className = "install-step-hint";
    hint.textContent =
      platform === "macos"
        ? 'No admin password needed. Close Terminal after it says "installed successfully".'
        : "No sudo needed.";
    step2.content.appendChild(hint);

    if (platform === "macos") {
      const gatekeeper = document.createElement("div");
      gatekeeper.className = "install-step-hint";
      gatekeeper.textContent =
        "If macOS says the helper can’t be checked for malware: Control-click the file in Finder → Open, confirm Open. Or System Settings → Privacy & Security → Open Anyway. Then run the Terminal command again if needed.";
      step2.content.appendChild(gatekeeper);
    }

    steps.appendChild(step2.root);

    const step3 = createStep("3");
    step3.label.textContent = "Finish";
    const doneBody = document.createElement("div");
    doneBody.className = "install-step-body";
    doneBody.textContent =
      "Click this extension’s toolbar icon again. We’ll connect to the helper automatically.";
    step3.content.appendChild(step3.label);
    step3.content.appendChild(doneBody);
    steps.appendChild(step3.root);
  }

  content.appendChild(steps);

  // Advanced toggle for power users (Windows only -- macOS/Linux already show the command)
  if (platform === "windows" && runCmd) {
    const advancedToggle = document.createElement("button");
    advancedToggle.className = "install-advanced-toggle";
    advancedToggle.textContent = "Show terminal command";

    const advancedSection = document.createElement("div");
    advancedSection.className = "install-advanced-section hidden";
    advancedSection.appendChild(createCodeBlock(runCmd));

    advancedToggle.addEventListener("click", () => {
      const isHidden = advancedSection.classList.toggle("hidden");
      advancedToggle.textContent = isHidden
        ? "Show terminal command"
        : "Hide terminal command";
    });

    content.appendChild(advancedToggle);
    content.appendChild(advancedSection);
  }

  view.appendChild(content);
  root.appendChild(view);
}

/**
 * Creates a numbered step element with label and content containers.
 */
function createStep(number: string): {
  root: HTMLElement;
  content: HTMLElement;
  label: HTMLElement;
} {
  const root = document.createElement("div");
  root.className = "install-step";

  const badge = document.createElement("div");
  badge.className = "install-step-number";
  badge.textContent = number;

  const content = document.createElement("div");
  content.className = "install-step-content";

  const label = document.createElement("div");
  label.className = "install-step-label";

  root.appendChild(badge);
  root.appendChild(content);

  return { root, content, label };
}

/**
 * Creates a code block with a copy button.
 */
function createCodeBlock(command: string): HTMLElement {
  const codeBlock = document.createElement("div");
  codeBlock.className = "code-block";

  const code = document.createElement("code");
  code.textContent = command;
  codeBlock.appendChild(code);

  const copyBtn = document.createElement("button");
  copyBtn.className = "btn btn-ghost code-block-copy";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => {
    copyToClipboard(command);
    showToast("Command copied to clipboard");
    copyBtn.textContent = "Copied!";
    setTimeout(() => {
      copyBtn.textContent = "Copy";
    }, 2000);
  });
  codeBlock.appendChild(copyBtn);

  return codeBlock;
}

/**
 * Detects CPU architecture: arm64 vs amd64.
 * Checks userAgentData (Chromium) and falls back to the UA string (Firefox).
 * Firefox doesn't support userAgentData and reports ARM Macs as Intel in the
 * UA string, so we also check the platform string.
 */
function detectArch(): "arm64" | "amd64" {
  // Chromium exposes architecture as a low-entropy hint
  const uaData = (navigator as unknown as { userAgentData?: { architecture?: string } }).userAgentData;
  if (uaData?.architecture === "arm") {
    return "arm64";
  }

  // Check platform (works in Firefox — "MacIntel" even on ARM, but "aarch64" on Linux ARM)
  const platform = navigator.platform?.toLowerCase() ?? "";
  if (platform.includes("aarch64") || platform.includes("arm")) {
    return "arm64";
  }

  // On macOS, check if running under Rosetta by looking for Apple Silicon indicators
  // navigator.platform is "MacIntel" on both Intel and ARM Macs, so use GL renderer
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl");
    if (gl) {
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      if (debugInfo) {
        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        if (typeof renderer === "string" && renderer.includes("Apple")) {
          // Apple GPU = Apple Silicon (Intel Macs use AMD/Intel GPUs)
          return "arm64";
        }
      }
    }
  } catch {
    // Canvas not available in some contexts, fall through
  }

  return "amd64";
}
