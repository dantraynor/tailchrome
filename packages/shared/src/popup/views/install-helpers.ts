import { copyToClipboard, showToast, detectPlatform } from "../utils";
import { EXPECTED_HOST_VERSION } from "../../constants";
import { iconPackage, iconRefresh } from "../icons";
import { renderUiSurfaceFooter } from "../components/ui-surface-row";
import { sendMessage } from "../popup";

export type Platform = "macos" | "linux" | "windows" | "unknown";
export type Architecture = "arm64" | "amd64" | "unknown";

export interface InstallerDownload {
  filename: string | null;
  label: string;
  url: string;
}

const RELEASES_BASE = "https://github.com/dantraynor/tailchrome/releases";
const PINNED_RELEASE_TAG = `v${EXPECTED_HOST_VERSION.replace(/^v/, "")}`;
const PINNED_RELEASE_BASE = `${RELEASES_BASE}/download/${PINNED_RELEASE_TAG}`;
const PINNED_RELEASE_PAGE = `${RELEASES_BASE}/tag/${PINNED_RELEASE_TAG}`;
const PINNED_INSTALL_SCRIPT_URL = `${PINNED_RELEASE_BASE}/tailchrome-install.sh`;
const PINNED_CHECKSUMS_URL = `${PINNED_RELEASE_BASE}/SHA256SUMS.txt`;
const VERIFIED_INSTALL_COMMAND =
  `bash ~/Downloads/tailchrome-install.sh --version "${PINNED_RELEASE_TAG}"`;
const VERIFY_INSTALL_SCRIPT_COMMAND =
  "cd ~/Downloads && grep -E '^[0-9a-f]{64}  tailchrome-install\\.sh$' SHA256SUMS.txt > tailchrome-install.sh.sha256 && test \"$(wc -l < tailchrome-install.sh.sha256)\" -eq 1 && sha256sum --check tailchrome-install.sh.sha256";

function releaseAssetURL(filename: string): string {
  return `${PINNED_RELEASE_BASE}/${filename}`;
}

function companionReleaseDownload(): InstallerDownload {
  return {
    filename: null,
    label: "Open companion release",
    url: PINNED_RELEASE_PAGE,
  };
}

/**
 * Returns package-first installer downloads for the detected platform and
 * architecture. Linux ARM64 uses the checksum-verifying release installer
 * because the OS packages are x64-only.
 */
export function installerDownloads(
  platform: Platform,
  arch: Architecture = "amd64",
): InstallerDownload[] {
  if (platform === "macos") {
    if (arch === "unknown") {
      return [companionReleaseDownload()];
    }
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
    if (arch === "unknown") {
      return [companionReleaseDownload()];
    }
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
    if (arch === "arm64") {
      return [
        {
          filename: "tailchrome-install.sh",
          label: "Download verified Linux ARM64 installer",
          url: PINNED_INSTALL_SCRIPT_URL,
        },
      ];
    }
    if (arch === "unknown") {
      return [companionReleaseDownload()];
    }
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
  return [companionReleaseDownload()];
}

/**
 * Returns the filename of the raw native host binary for advanced fallback use.
 */
export function binaryFilename(
  platform: Platform,
  arch: Architecture = "amd64",
): string | null {
  if (platform === "windows" && arch !== "unknown") {
    return "tailscale-browser-ext-windows-amd64.exe";
  }
  if (platform === "linux") {
    return arch === "amd64" ? "tailscale-browser-ext-linux-amd64" : null;
  }
  if (platform === "macos" && arch !== "unknown") {
    return `tailscale-browser-ext-darwin-${arch}`;
  }
  return null;
}

/**
 * Returns the download URL for the raw native host binary.
 */
export function buildDownloadURL(
  platform: Platform,
  arch: Architecture = "amd64",
): string {
  if (platform === "linux" && arch === "arm64") {
    return PINNED_INSTALL_SCRIPT_URL;
  }
  const filename = binaryFilename(platform, arch);
  if (filename) {
    return releaseAssetURL(filename);
  }
  return PINNED_RELEASE_PAGE;
}

/**
 * Returns the command to run after downloading the fallback. Linux ARM64 uses
 * the version-pinned verified installer instead of an unchecked raw binary.
 * Other raw binaries auto-install with the hardcoded extension IDs.
 */
export function buildRunCommand(
  platform: Platform,
  arch: Architecture = "amd64",
): string | null {
  if (platform === "linux" && arch === "arm64") {
    return VERIFIED_INSTALL_COMMAND;
  }

  const filename = binaryFilename(platform, arch);
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
export async function renderInstallFlow(
  root: HTMLElement,
  opts: { mode: "install" | "update"; hostVersion?: string | null },
): Promise<void> {
  // Keep a marker in the root while the asynchronous platform lookup runs. If
  // another view renders first, it removes the marker and this render stops
  // rather than overwriting newer state.
  const renderMarker = document.createComment("loading install flow");
  root.replaceChildren(renderMarker);

  const platform = detectPlatform();
  const arch = await detectArch();
  if (renderMarker.parentNode !== root) {
    return;
  }

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

  const downloads = installerDownloads(platform, arch);
  const filename = downloads[0]?.filename ?? null;
  const unsupported = platform === "unknown" || arch === "unknown";
  const usesVerifiedLinuxInstaller = platform === "linux" && arch === "arm64";
  const runCmd = buildRunCommand(platform, arch);

  const steps = document.createElement("div");
  steps.className = "install-steps";

  const step1 = createStep("1");
  step1.label.textContent =
    usesVerifiedLinuxInstaller
      ? "Download the verified installer"
      : unsupported
        ? "Open release information"
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
    unsupported ? "Review supported releases" : "Run the installer";
  step2.content.appendChild(step2.label);
  step2.content.appendChild(
    createInstallInstructions(platform, arch, filename, opts.mode),
  );
  steps.appendChild(step2.root);

  const step3 = createStep("3");
  step3.label.textContent = "Finish";
  const doneBody = document.createElement("div");
  doneBody.className = "install-step-body";
  doneBody.textContent =
    unsupported
      ? "Return after installing a supported helper build. Tailchrome will connect automatically."
      : "Leave this popup open or reopen it after setup. Tailchrome will connect automatically.";
  step3.content.appendChild(step3.label);
  step3.content.appendChild(doneBody);
  steps.appendChild(step3.root);

  content.appendChild(steps);

  if (runCmd && !usesVerifiedLinuxInstaller) {
    content.appendChild(createRawBinaryFallback(platform, arch, runCmd));
  }

  view.appendChild(content);
  renderUiSurfaceFooter(view);
  root.replaceChildren(view);
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
  arch: Architecture,
  filename: string | null,
  mode: "install" | "update",
): HTMLElement {
  const wrapper = document.createElement("div");

  const body = document.createElement("div");
  body.className = "install-step-body";

  if (platform === "unknown" || arch === "unknown") {
    body.textContent =
      "No compatible installer was selected. Review the companion release for supported operating systems and architectures.";
  } else if (platform === "macos") {
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
  } else if (platform === "linux" && arch === "arm64") {
    body.textContent =
      "Run the version-pinned installer. It downloads the Linux ARM64 helper, verifies its SHA-256 checksum, and registers Tailchrome with your browsers:";
  } else if (platform === "linux") {
    body.textContent =
      "Install the package with your system installer, or use one of these commands:";
  } else {
    body.textContent = "Open the downloaded file to complete setup.";
  }

  wrapper.appendChild(body);

  if (platform === "linux" && arch === "arm64") {
    appendVerifiedLinuxInstallerInstructions(wrapper);
  } else if (platform === "linux" && arch === "amd64") {
    wrapper.appendChild(createCodeBlock("sudo apt install ~/Downloads/tailchrome-helper-linux-amd64.deb"));
    wrapper.appendChild(createCodeBlock("sudo dnf install ~/Downloads/tailchrome-helper-linux-x86_64.rpm"));
  }

  const hint = document.createElement("div");
  hint.className = "install-step-hint";
  if (platform === "unknown" || arch === "unknown") {
    hint.textContent =
      "Tailchrome does not guess an installer when runtime architecture information is unsupported.";
  } else if (platform === "macos") {
    hint.textContent =
      "If setup needs repair later, open Tailchrome Helper from Applications.";
  } else if (platform === "windows" && mode === "update") {
    hint.textContent =
      'If it still says "Update Available" after setup, fully quit your browser and reopen it.';
  } else if (platform === "linux" && arch === "arm64") {
    hint.textContent =
      "Setup stops without installing anything if the published checksum does not match.";
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

function appendVerifiedLinuxInstallerInstructions(
  container: HTMLElement,
): void {
  const checksum = document.createElement("a");
  checksum.className = "btn btn-secondary btn-link";
  checksum.href = PINNED_CHECKSUMS_URL;
  checksum.target = "_blank";
  checksum.rel = "noopener";
  checksum.textContent = "Download release checksums";
  checksum.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: checksum.href });
  });
  container.appendChild(checksum);
  container.appendChild(createCodeBlock(VERIFY_INSTALL_SCRIPT_COMMAND));

  const provenance = document.createElement("p");
  provenance.className = "install-step-hint";
  provenance.textContent =
    "If GitHub CLI is installed, verify provenance too. Inspect the script before running it.";
  container.appendChild(provenance);
  container.appendChild(
    createCodeBlock(
      "gh attestation verify ~/Downloads/tailchrome-install.sh --hostname github.com --repo dantraynor/tailchrome",
    ),
  );
  container.appendChild(
    createCodeBlock("less ~/Downloads/tailchrome-install.sh"),
  );
  container.appendChild(createCodeBlock(VERIFIED_INSTALL_COMMAND));
}

function createRawBinaryFallback(
  platform: Platform,
  arch: Architecture,
  runCmd: string,
): HTMLElement {
  const container = document.createElement("div");

  const advancedToggle = document.createElement("button");
  advancedToggle.className = "install-advanced-toggle";
  advancedToggle.textContent = "Show raw binary fallback";

  const advancedSection = document.createElement("div");
  advancedSection.className = "install-advanced-section hidden";

  const download = document.createElement("a");
  download.className = "btn btn-secondary btn-link";
  download.href = buildDownloadURL(platform, arch);
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
 * Detects CPU architecture through the extension runtime API. Reduced browser
 * user-agent values do not reliably expose architecture, so navigator and
 * WebGL checks are only used if the runtime API is unavailable.
 */
export async function detectArch(): Promise<Architecture> {
  try {
    const info = await getPlatformInfo();
    return normalizeArchitecture(info?.arch);
  } catch {
    // Fall through when the API is unavailable or the platform lookup fails.
  }

  return detectArchFallback();
}

function normalizeArchitecture(value: unknown): Architecture {
  const arch = String(value ?? "").toLowerCase();
  if (arch === "arm64" || arch === "aarch64") {
    return "arm64";
  }
  if (arch === "x86-64" || arch === "x86_64" || arch === "amd64") {
    return "amd64";
  }
  return "unknown";
}

/**
 * Supports both Firefox's callback-style chrome compatibility API and
 * Chromium's Promise-returning API. Some implementations expose both, so only
 * the first result is allowed to settle the lookup.
 */
function getPlatformInfo(): Promise<chrome.runtime.PlatformInfo> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const resolveOnce = (info: chrome.runtime.PlatformInfo): void => {
      if (settled) return;
      settled = true;
      resolve(info);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    try {
      const getPlatformInfoCompat = chrome.runtime
        .getPlatformInfo as unknown as (
        callback: (info: chrome.runtime.PlatformInfo) => void,
      ) => void | Promise<chrome.runtime.PlatformInfo>;
      const result = getPlatformInfoCompat.call(chrome.runtime, (info) => {
        // lastError is only valid while an extension API callback is running.
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          rejectOnce(new Error(lastError.message ?? "Platform lookup failed"));
          return;
        }
        resolveOnce(info);
      });

      if (result && typeof result.then === "function") {
        result.then(resolveOnce, rejectOnce);
      }
    } catch (error) {
      rejectOnce(error);
    }
  });
}

function detectArchFallback(): Architecture {
  const userAgentData = (
    navigator as unknown as { userAgentData?: { architecture?: string } }
  ).userAgentData;
  const highEntropyArchitecture = normalizeArchitecture(
    userAgentData?.architecture,
  );
  if (highEntropyArchitecture !== "unknown") {
    return highEntropyArchitecture;
  }

  const platformAndUA =
    `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase();
  if (
    platformAndUA.includes("aarch64") ||
    platformAndUA.includes("arm64") ||
    platformAndUA.includes("armv8")
  ) {
    return "arm64";
  }
  if (
    platformAndUA.includes("x86_64") ||
    platformAndUA.includes("x86-64") ||
    platformAndUA.includes("amd64") ||
    platformAndUA.includes("win64") ||
    platformAndUA.includes("x64")
  ) {
    return "amd64";
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

  return "unknown";
}
