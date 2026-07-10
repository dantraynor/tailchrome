import { copyToClipboard, showToast, detectPlatform } from "../utils";
import { EXPECTED_HOST_VERSION } from "../../constants";
import { iconPackage, iconRefresh } from "../icons";
import { renderUiSurfaceFooter } from "../components/ui-surface-row";
import { sendMessage } from "../popup";

export type Platform = "macos" | "linux" | "windows" | "unknown";

export interface InstallerDownload {
  filename: string | null;
  label: string;
  url: string;
}

const RELEASE_BASE =
  "https://github.com/dantraynor/tailchrome/releases/latest/download";
const RELEASE_PAGE = "https://github.com/dantraynor/tailchrome/releases/latest";

function releaseAssetURL(filename: string): string {
  return `${RELEASE_BASE}/${filename}`;
}

/**
 * Returns package-first installer downloads for the detected platform.
 */
export function installerDownloads(platform: Platform): InstallerDownload[] {
  if (platform === "macos") {
    const filename = "tailchrome-helper-macos.pkg";
    return [
      {
        filename,
        label: "Download macOS installer (.pkg)",
        url: releaseAssetURL(filename),
      },
    ];
  }
  if (platform === "windows") {
    const filename = "tailchrome-helper-windows-x64.msi";
    return [
      {
        filename,
        label: "Download Windows installer (.msi)",
        url: releaseAssetURL(filename),
      },
    ];
  }
  if (platform === "linux") {
    const deb = "tailchrome-helper-linux-amd64.deb";
    const rpm = "tailchrome-helper-linux-x86_64.rpm";
    return [
      {
        filename: deb,
        label: "Download .deb (Debian/Ubuntu)",
        url: releaseAssetURL(deb),
      },
      {
        filename: rpm,
        label: "Download .rpm (Fedora/RHEL)",
        url: releaseAssetURL(rpm),
      },
    ];
  }
  return [
    {
      filename: null,
      label: "Open latest release",
      url: RELEASE_PAGE,
    },
  ];
}

/**
 * Returns the filename of the raw native host binary for advanced fallback use.
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
 * Returns the download URL for the raw native host binary.
 */
export function buildDownloadURL(platform: Platform): string {
  const filename = binaryFilename(platform);
  if (filename) {
    return releaseAssetURL(filename);
  }
  return RELEASE_PAGE;
}

/**
 * Returns the command to run after downloading the raw binary fallback.
 * The binary auto-installs with the hardcoded extension IDs.
 */
export function buildRunCommand(platform: Platform): string | null {
  const filename = binaryFilename(platform);
  if (!filename) {
    return null;
  }
  if (platform === "windows") {
    return `cd %USERPROFILE%\\Downloads && .\\${filename}`;
  }
  return `chmod +x ~/Downloads/${filename} && ~/Downloads/${filename}`;
}

/**
 * Asks the background service worker to poll native-host discovery after the
 * user starts an installer. The background owns the retry timers: opening the
 * download tab closes the popup surface, which would destroy any timers
 * scheduled in this document before they fire.
 */
export function requestNativeHostRetries(): void {
  sendMessage({ type: "retry-native-host" });
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

  const icon = document.createElement("div");
  icon.className = "centered-view-icon";
  const iconEl = document.createElement("span");
  iconEl.className = "icon icon-2xl";
  iconEl.appendChild(opts.mode === "install" ? iconPackage() : iconRefresh());
  icon.appendChild(iconEl);

  const title = document.createElement("h2");
  title.className = "centered-view-title";
  title.textContent = opts.mode === "install" ? "Quick Setup" : "Update Available";

  const description = document.createElement("p");
  description.className = "centered-view-text";
  description.textContent =
    opts.mode === "install"
      ? "Tailscale needs a small helper app to connect your browser to your tailnet."
      : "A newer version of the helper app is needed for this extension.";

  content.appendChild(icon);
  content.appendChild(title);
  content.appendChild(description);

  if (opts.mode === "update") {
    const versionInfo = document.createElement("p");
    versionInfo.className = "centered-view-text version-info";
    const currentLabel = opts.hostVersion ?? "unknown";
    versionInfo.textContent = `Installed: ${currentLabel} \u2192 Required: ${EXPECTED_HOST_VERSION}`;
    content.appendChild(versionInfo);
  }

  const platform = detectPlatform();
  const downloads = installerDownloads(platform);
  const filename = downloads[0]?.filename ?? null;
  const runCmd = buildRunCommand(platform);

  const steps = document.createElement("div");
  steps.className = "install-steps";

  const step1 = createStep("1");
  step1.label.textContent =
    platform === "unknown"
      ? "Download the helper app"
      : "Download the helper installer";

  const cta = document.createElement("div");
  cta.className = "install-pkg-cta";
  for (const download of downloads) {
    cta.appendChild(createDownloadButton(download));
  }
  step1.content.appendChild(step1.label);
  step1.content.appendChild(cta);
  steps.appendChild(step1.root);

  const step2 = createStep("2");
  step2.label.textContent =
    platform === "unknown" ? "Open the downloaded file" : "Run the installer";
  step2.content.appendChild(step2.label);
  step2.content.appendChild(createInstallInstructions(platform, filename, opts.mode));
  steps.appendChild(step2.root);

  const step3 = createStep("3");
  step3.label.textContent = "Finish";
  const doneBody = document.createElement("div");
  doneBody.className = "install-step-body";
  doneBody.textContent =
    "Leave this popup open or reopen it after setup. Tailchrome will connect automatically.";
  step3.content.appendChild(step3.label);
  step3.content.appendChild(doneBody);
  steps.appendChild(step3.root);

  content.appendChild(steps);

  if (runCmd) {
    content.appendChild(createRawBinaryFallback(platform, runCmd));
  }

  view.appendChild(content);
  renderUiSurfaceFooter(view);
  root.appendChild(view);
}

function createDownloadButton(download: InstallerDownload): HTMLElement {
  const link = document.createElement("a");
  link.className = "btn btn-primary btn-link";
  link.href = download.url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = download.label;
  link.addEventListener("click", (e) => {
    e.preventDefault();
    requestNativeHostRetries();
    chrome.tabs.create({ url: download.url });
    setTimeout(() => {
      link.textContent = "Downloaded? Run it next";
      link.classList.remove("btn-primary");
      link.classList.add("btn-secondary");
    }, 500);
  });
  return link;
}

function createInstallInstructions(
  platform: Platform,
  filename: string | null,
  mode: "install" | "update",
): HTMLElement {
  const wrapper = document.createElement("div");

  const body = document.createElement("div");
  body.className = "install-step-body";

  if (platform === "macos") {
    body.textContent =
      "Open the downloaded package and complete the installer. Setup runs automatically when the package finishes.";
  } else if (platform === "windows") {
    body.appendChild(document.createTextNode("Find "));
    const strong = document.createElement("strong");
    strong.textContent = filename ?? "the downloaded installer";
    body.appendChild(strong);
    body.appendChild(
      document.createTextNode(" in your Downloads folder and double-click it."),
    );
  } else if (platform === "linux") {
    body.textContent =
      "Install the package with your system installer, or use one of these commands:";
  } else {
    body.textContent = "Open the downloaded file to complete setup.";
  }

  wrapper.appendChild(body);

  if (platform === "linux") {
    wrapper.appendChild(createCodeBlock("sudo apt install ~/Downloads/tailchrome-helper-linux-amd64.deb"));
    wrapper.appendChild(createCodeBlock("sudo dnf install ~/Downloads/tailchrome-helper-linux-x86_64.rpm"));
  }

  const hint = document.createElement("div");
  hint.className = "install-step-hint";
  if (platform === "macos") {
    hint.textContent =
      "If setup needs repair later, open Tailchrome Helper from Applications.";
  } else if (platform === "windows" && mode === "update") {
    hint.textContent =
      'If it still says "Update Available" after setup, fully quit your browser and reopen it.';
  } else if (platform === "linux") {
    hint.textContent =
      "The package registers system-wide browser manifests for Chrome, Chromium, Edge, and Firefox.";
  } else {
    hint.textContent =
      `The ${platformLabel(platform)} helper registers itself with supported browsers.`;
  }
  wrapper.appendChild(hint);

  return wrapper;
}

function createRawBinaryFallback(platform: Platform, runCmd: string): HTMLElement {
  const container = document.createElement("div");

  const advancedToggle = document.createElement("button");
  advancedToggle.className = "install-advanced-toggle";
  advancedToggle.textContent = "Show raw binary fallback";

  const advancedSection = document.createElement("div");
  advancedSection.className = "install-advanced-section hidden";

  const download = document.createElement("a");
  download.className = "btn btn-secondary btn-link";
  download.href = buildDownloadURL(platform);
  download.target = "_blank";
  download.rel = "noopener";
  download.textContent = "Download raw helper binary";
  download.addEventListener("click", (e) => {
    e.preventDefault();
    requestNativeHostRetries();
    chrome.tabs.create({ url: download.href });
  });

  advancedSection.appendChild(download);
  advancedSection.appendChild(createCodeBlock(runCmd));

  advancedToggle.addEventListener("click", () => {
    const isHidden = advancedSection.classList.toggle("hidden");
    advancedToggle.textContent = isHidden
      ? "Show raw binary fallback"
      : "Hide raw binary fallback";
  });

  container.appendChild(advancedToggle);
  container.appendChild(advancedSection);
  return container;
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
  const uaData = (navigator as unknown as { userAgentData?: { architecture?: string } }).userAgentData;
  if (uaData?.architecture === "arm") {
    return "arm64";
  }

  const platform = navigator.platform?.toLowerCase() ?? "";
  if (platform.includes("aarch64") || platform.includes("arm")) {
    return "arm64";
  }

  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl");
    if (gl) {
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      if (debugInfo) {
        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        if (typeof renderer === "string" && renderer.includes("Apple")) {
          return "arm64";
        }
      }
    }
  } catch {
    // Canvas may be unavailable in test or restricted extension contexts.
  }

  return "amd64";
}
