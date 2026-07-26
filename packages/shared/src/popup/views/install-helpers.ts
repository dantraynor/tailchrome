import type { HelperFailureKind, TailscaleState } from "../../types";
import { copyToClipboard, showToast } from "../utils";
import { iconPackage } from "../icons";
import { renderUiSurfaceFooter } from "../components/ui-surface-row";
import { sendMessage } from "../popup";
import { appendHelperDiagnosticActions } from "../helper-diagnostics";

export type Platform = "macos" | "linux" | "windows" | "unknown";
export type InstallerArchitecture = "amd64" | "arm64" | "unknown";

export interface InstallerPlatform {
  platform: Platform;
  architecture: InstallerArchitecture;
}

interface RuntimePlatformInfo {
  os: string;
  arch: string;
}

export interface InstallerDownload {
  filename: string | null;
  label: string;
  url: string;
}

const RELEASES_BASE =
  "https://github.com/dantraynor/tailchrome/releases";

function currentReleaseVersion(): string {
  return chrome.runtime.getManifest().version.replace(/^v/, "");
}

function releaseAssetURL(filename: string): string {
  return `${RELEASES_BASE}/download/v${currentReleaseVersion()}/${filename}`;
}

function releasePageURL(): string {
  return `${RELEASES_BASE}/tag/v${currentReleaseVersion()}`;
}

export function normalizeInstallerPlatform(
  info: RuntimePlatformInfo,
): InstallerPlatform {
  const platform: Platform =
    info.os === "mac"
      ? "macos"
      : info.os === "win"
        ? "windows"
        : info.os === "linux"
          ? "linux"
          : "unknown";
  const architecture: InstallerArchitecture =
    info.arch === "x86-64"
      ? "amd64"
      : info.arch === "arm64" || info.arch === "aarch64"
        ? "arm64"
        : "unknown";
  return { platform, architecture };
}

async function getInstallerPlatform(): Promise<InstallerPlatform> {
  try {
    const info = await chrome.runtime.getPlatformInfo();
    return normalizeInstallerPlatform({
      os: String(info.os),
      arch: String(info.arch),
    });
  } catch {
    return { platform: "unknown", architecture: "unknown" };
  }
}

/**
 * Returns package-first installer downloads for the detected platform.
 */
export function installerDownloads(
  platform: Platform,
  architecture: InstallerArchitecture,
): InstallerDownload[] {
  if (
    platform === "macos" &&
    (architecture === "amd64" || architecture === "arm64")
  ) {
    const filename = "tailchrome-helper-macos.pkg";
    return [
      {
        filename,
        label: "Download macOS installer (.pkg)",
        url: releaseAssetURL(filename),
      },
    ];
  }
  if (
    platform === "windows" &&
    (architecture === "amd64" || architecture === "arm64")
  ) {
    const filename = "tailchrome-helper-windows-x64.msi";
    return [
      {
        filename,
        label: "Download Windows installer (.msi)",
        url: releaseAssetURL(filename),
      },
    ];
  }
  if (platform === "linux" && architecture === "amd64") {
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
  if (platform === "linux" && architecture === "arm64") {
    const filename = "tailchrome-install.sh";
    return [
      {
        filename,
        label: "Download verified Linux ARM64 installer",
        url: releaseAssetURL(filename),
      },
    ];
  }
  return [
    {
      filename: null,
      label: "Open latest release",
      url: releasePageURL(),
    },
  ];
}

/**
 * Returns the filename of the raw native host binary for advanced fallback use.
 */
export function binaryFilename(
  platform: Platform,
  architecture: InstallerArchitecture,
): string | null {
  if (
    platform === "windows" &&
    (architecture === "amd64" || architecture === "arm64")
  ) {
    return "tailscale-browser-ext-windows-amd64.exe";
  }
  if (platform === "linux" && architecture !== "unknown") {
    return `tailscale-browser-ext-linux-${architecture}`;
  }
  if (platform === "macos" && architecture !== "unknown") {
    return `tailscale-browser-ext-darwin-${architecture}`;
  }
  return null;
}

/**
 * Returns the download URL for the raw native host binary.
 */
export function buildDownloadURL(
  platform: Platform,
  architecture: InstallerArchitecture,
): string {
  const filename = binaryFilename(platform, architecture);
  if (filename) {
    return releaseAssetURL(filename);
  }
  return releasePageURL();
}

/**
 * Returns the command for the version-pinned verified repair installer.
 */
function repairRunCommand(
  platform: Platform,
  architecture: InstallerArchitecture,
): string | null {
  const version = `v${currentReleaseVersion()}`;
  if (
    (platform === "macos" || platform === "linux") &&
    (architecture === "amd64" || architecture === "arm64")
  ) {
    return `bash ~/Downloads/tailchrome-install.sh --version "${version}"`;
  }
  if (
    platform === "windows" &&
    (architecture === "amd64" || architecture === "arm64")
  ) {
    return "msiexec.exe /fa .\\tailchrome-helper-windows-x64.msi";
  }
  return null;
}

/**
 * Asks the background service worker to poll native-host discovery after the
 * user starts an installer. The background owns the retry timers: opening the
 * download tab closes the popup surface, which would destroy any timers
 * scheduled in this document before they fire.
 */
export function requestNativeHostRetries(
  source: "package" | "fallback" | "manual",
): void {
  sendMessage({ type: "retry-native-host", source });
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
 * Renders the helper install and registration-repair flow.
 */
export async function renderInstallFlow(
  root: HTMLElement,
  opts: { mode: "install"; state: TailscaleState },
): Promise<void> {
  root.textContent = "";
  const pending = document.createElement("div");
  pending.className = "centered-view-text";
  pending.textContent = "Preparing helper options\u2026";
  root.appendChild(pending);

  const { platform, architecture } = await getInstallerPlatform();
  if (pending.parentElement !== root) {
    return;
  }

  root.textContent = "";
  const view = document.createElement("div");
  view.className = "view";

  const content = document.createElement("div");
  content.className = "centered-view";

  const icon = document.createElement("div");
  icon.className = "centered-view-icon";
  const iconEl = document.createElement("span");
  iconEl.className = "icon icon-2xl";
  iconEl.appendChild(iconPackage());
  icon.appendChild(iconEl);

  const title = document.createElement("h2");
  title.className = "centered-view-title";
  const repairProminent =
    opts.state.repairRegistrationAvailable ||
    opts.state.helperFailure?.kind === "helper-not-allowed";
  title.textContent = repairProminent
    ? "Repair registration"
    : "Quick Setup";

  const description = document.createElement("p");
  description.className = "centered-view-text";
  description.textContent = helperFailureDescription(
    opts.state.helperFailure?.kind,
  );

  content.appendChild(icon);
  content.appendChild(title);
  content.appendChild(description);

  if (repairProminent) {
    const repair = document.createElement("div");
    repair.className = "helper-registration-repair";
    const repairTitle = document.createElement("strong");
    repairTitle.textContent = "Repair registration for this browser";
    const repairBody = document.createElement("p");
    repairBody.textContent =
      "Restore current-user registration with the verified repair below, then retry discovery. Your Tailscale session is not changed.";
    repair.append(repairTitle, repairBody);
    content.appendChild(repair);
  }

  const downloads = installerDownloads(platform, architecture);
  const filename = downloads[0]?.filename ?? null;
  const unsupported =
    platform === "unknown" || architecture === "unknown";
  const repairActionAvailable =
    repairRunCommand(platform, architecture) !== null;
  if (repairProminent && repairActionAvailable) {
    content.appendChild(
      createVerifiedRepairFallback(platform, architecture, true),
    );
  }

  const steps = document.createElement("div");
  steps.className = "install-steps";
  const showPackageInstall =
    opts.state.helperFailure?.kind !== "helper-not-allowed" &&
    !(repairProminent && platform === "linux" && architecture === "arm64");

  if (showPackageInstall) {
    const step1 = createStep("1");
    step1.label.textContent = repairProminent
      ? "Or reinstall the release package"
      : unsupported
        ? "Open release information"
        : "Download the helper installer";

    const cta = document.createElement("div");
    cta.className = "install-pkg-cta";
    for (const download of downloads) {
      const retrySource =
        download.filename === null
          ? null
          : download.filename === "tailchrome-install.sh"
            ? "fallback"
            : "package";
      cta.appendChild(createDownloadButton(download, retrySource));
    }
    step1.content.appendChild(step1.label);
    step1.content.appendChild(cta);
    steps.appendChild(step1.root);

    const step2 = createStep("2");
    step2.label.textContent =
      unsupported
        ? "Review supported releases"
        : "Run the installer";
    step2.content.appendChild(step2.label);
    step2.content.appendChild(
      createInstallInstructions(platform, architecture, filename),
    );
    steps.appendChild(step2.root);

    const step3 = createStep("3");
    step3.label.textContent = "Finish";
    const doneBody = document.createElement("div");
    doneBody.className = "install-step-body";
    doneBody.textContent = unsupported
      ? "Return after installing a supported helper build, then retry discovery."
      : "Leave this popup open or reopen it after setup. Tailchrome will retry automatically.";
    step3.content.appendChild(step3.label);
    step3.content.appendChild(doneBody);
    step3.content.appendChild(createDiscoveryRetryButton());
    steps.appendChild(step3.root);
    content.appendChild(steps);
  } else {
    content.appendChild(createDiscoveryRetryButton());
  }

  if (
    !repairProminent &&
    repairActionAvailable &&
    !(platform === "linux" && architecture === "arm64")
  ) {
    content.appendChild(
      createVerifiedRepairFallback(platform, architecture, false),
    );
  }

  if (opts.state.helperFailure) {
    appendHelperDiagnosticActions(content, opts.state);
  }

  view.appendChild(content);
  renderUiSurfaceFooter(view);
  root.appendChild(view);
}

function createDownloadButton(
  download: InstallerDownload,
  source: "package" | "fallback" | null,
): HTMLElement {
  const link = document.createElement("a");
  link.className = "btn btn-primary btn-link";
  link.href = download.url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = download.label;
  link.addEventListener("click", (e) => {
    e.preventDefault();
    if (source) {
      requestNativeHostRetries(source);
    }
    chrome.tabs.create({ url: download.url });
    setTimeout(() => {
      link.textContent = "Downloaded? Run it next";
      link.classList.remove("btn-primary");
      link.classList.add("btn-secondary");
    }, 500);
  });
  return link;
}

function createDiscoveryRetryButton(): HTMLButtonElement {
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "btn btn-secondary helper-discovery-retry";
  retry.textContent = "Retry discovery";
  retry.addEventListener("click", () => {
    requestNativeHostRetries("manual");
    retry.disabled = true;
    retry.textContent = "Retrying\u2026";
  });
  return retry;
}

function createInstallInstructions(
  platform: Platform,
  architecture: InstallerArchitecture,
  filename: string | null,
): HTMLElement {
  const wrapper = document.createElement("div");

  const body = document.createElement("div");
  body.className = "install-step-body";

  const unsupported =
    platform === "unknown" || architecture === "unknown";
  if (unsupported) {
    body.textContent =
      "No compatible installer was selected. Review the release notes for supported operating systems and architectures.";
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
    if (architecture === "arm64") {
      body.appendChild(
        document.createTextNode(
          " Windows runs this signed x64 helper through x64 emulation.",
        ),
      );
    }
  } else if (platform === "linux" && architecture === "arm64") {
    body.textContent =
      "The version-pinned Linux ARM64 installer verifies tailscale-browser-ext-linux-arm64 before installing and registering it:";
  } else if (platform === "linux") {
    body.textContent =
      "Install the package with your system installer, or use one of these commands:";
  } else {
    body.textContent = "Open the downloaded file to complete setup.";
  }

  wrapper.appendChild(body);

  if (!unsupported && platform === "linux" && architecture === "arm64") {
    appendRepairScriptVerification(wrapper, platform, architecture);
  } else if (!unsupported && platform === "linux") {
    wrapper.appendChild(
      createCodeBlock(
        "sudo apt install ~/Downloads/tailchrome-helper-linux-amd64.deb",
      ),
    );
    wrapper.appendChild(
      createCodeBlock(
        "sudo dnf install ~/Downloads/tailchrome-helper-linux-x86_64.rpm",
      ),
    );
  }

  const hint = document.createElement("div");
  hint.className = "install-step-hint";
  if (unsupported) {
    hint.textContent =
      "Tailchrome does not guess an installer when runtime platform information is unsupported.";
  } else if (platform === "macos") {
    hint.textContent =
      "If setup needs repair later, open Tailchrome Helper from Applications.";
  } else if (platform === "linux" && architecture === "arm64") {
    hint.textContent =
      "The verified helper installs per-user manifests for Chrome, Chromium, Edge, and Firefox.";
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

function appendRepairScriptVerification(
  container: HTMLElement,
  platform: "macos" | "linux",
  architecture: InstallerArchitecture,
): void {
  const checksum = document.createElement("a");
  checksum.className = "btn btn-secondary btn-link";
  checksum.href = releaseAssetURL("SHA256SUMS.txt");
  checksum.target = "_blank";
  checksum.rel = "noopener";
  checksum.textContent = "Download release checksums";
  checksum.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: checksum.href });
  });
  container.appendChild(checksum);

  const checksumTool =
    platform === "macos"
      ? "shasum -a 256 --check"
      : "sha256sum --check";
  container.appendChild(
    createCodeBlock(
      `cd ~/Downloads && grep -E '^[0-9a-f]{64}  tailchrome-install\\.sh$' SHA256SUMS.txt > tailchrome-install.sh.sha256 && test "$(wc -l < tailchrome-install.sh.sha256)" -eq 1 && ${checksumTool} tailchrome-install.sh.sha256`,
    ),
  );

  const provenance = document.createElement("p");
  provenance.className = "install-step-hint";
  provenance.textContent =
    "If GitHub CLI is installed, verify provenance too. Inspect the script before running it.";
  container.appendChild(provenance);
  container.appendChild(
    createCodeBlock(
      "gh attestation verify ~/Downloads/tailchrome-install.sh --repo dantraynor/tailchrome",
    ),
  );
  container.appendChild(
    createCodeBlock("less ~/Downloads/tailchrome-install.sh"),
  );

  const runCmd = repairRunCommand(platform, architecture);
  if (runCmd) {
    container.appendChild(createCodeBlock(runCmd));
  }
}

function createVerifiedRepairFallback(
  platform: Platform,
  architecture: InstallerArchitecture,
  prominent: boolean,
): HTMLElement {
  const container = document.createElement("div");

  const advancedSection = document.createElement("div");
  advancedSection.className = prominent
    ? "install-advanced-section"
    : "install-advanced-section hidden";

  if (platform === "macos" && prominent) {
    const heading = document.createElement("strong");
    heading.textContent = "Open the installed repair app";
    const explanation = document.createElement("p");
    explanation.className = "install-step-body";
    explanation.textContent =
      "Open /Applications/Tailchrome Helper.app to restore current-user registration, then retry discovery.";
    advancedSection.append(heading, explanation);
    advancedSection.appendChild(
      createCodeBlock('open "/Applications/Tailchrome Helper.app"'),
    );
    container.appendChild(advancedSection);
    return container;
  }

  const advancedToggle = document.createElement("button");
  advancedToggle.className = "install-advanced-toggle";
  advancedToggle.type = "button";
  advancedToggle.textContent = "Show verified per-user repair";

  const download = document.createElement("a");
  download.className = prominent
    ? "btn btn-primary btn-link"
    : "btn btn-secondary btn-link";
  const filename =
    platform === "windows"
      ? "tailchrome-helper-windows-x64.msi"
      : "tailchrome-install.sh";
  download.href = releaseAssetURL(filename);
  download.target = "_blank";
  download.rel = "noopener";
  download.textContent =
    platform === "windows"
      ? "Download signed installer for repair"
      : "Download repair installer";
  download.addEventListener("click", (e) => {
    e.preventDefault();
    requestNativeHostRetries("fallback");
    chrome.tabs.create({ url: download.href });
  });

  const heading = document.createElement("strong");
  heading.textContent = "Verify, inspect, then run";
  advancedSection.appendChild(heading);
  advancedSection.appendChild(download);

  if (platform === "macos" || platform === "linux") {
    const expectedAsset = binaryFilename(platform, architecture);
    if (expectedAsset) {
      const explanation = document.createElement("p");
      explanation.className = "install-step-body";
      explanation.textContent =
        `The pinned installer downloads and verifies ${expectedAsset}, then restores current-user registration.`;
      advancedSection.appendChild(explanation);
    }
    appendRepairScriptVerification(
      advancedSection,
      platform,
      architecture,
    );
  } else {
    const runCmd = repairRunCommand(platform, architecture);
    if (runCmd) {
      advancedSection.appendChild(createCodeBlock(runCmd));
    }
  }

  if (!prominent) {
    advancedToggle.addEventListener("click", () => {
      const isHidden = advancedSection.classList.toggle("hidden");
      advancedToggle.textContent = isHidden
        ? "Show verified per-user repair"
        : "Hide verified per-user repair";
    });
    container.appendChild(advancedToggle);
  }
  container.appendChild(advancedSection);
  return container;
}

function helperFailureDescription(kind: HelperFailureKind | undefined): string {
  switch (kind) {
    case "helper-unavailable":
      return "Tailchrome could not find a registered helper for this browser.";
    case "helper-not-allowed":
      return "This browser refused access to the registered helper.";
    case "helper-incompatible":
      return "The helper and extension reported an incompatible protocol.";
    default:
      return "Tailscale needs a small helper app to connect your browser to your tailnet.";
  }
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
