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
const RELEASE_VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/**
 * The extension manifest is normally validated by Chrome, but keep release
 * URLs and shell commands safe even if a malformed value reaches this view.
 */
function currentReleaseTag(): string | null {
  const rawVersion = String(chrome.runtime.getManifest().version ?? "").replace(
    /^v/,
    "",
  );
  return RELEASE_VERSION_PATTERN.test(rawVersion) ? `v${rawVersion}` : null;
}

function releaseAssetURL(filename: string): string | null {
  const tag = currentReleaseTag();
  return tag
    ? `${RELEASES_BASE}/download/${tag}/${filename}`
    : null;
}

function releasePageURL(): string {
  const tag = currentReleaseTag();
  return tag ? `${RELEASES_BASE}/tag/${tag}` : RELEASES_BASE;
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

function downloadFor(filename: string, label: string): InstallerDownload[] {
  const url = releaseAssetURL(filename);
  return url ? [{ filename, label, url }] : [];
}

/**
 * Returns the supported release installer for the detected platform. The
 * first item is always the primary per-user path; package alternatives are
 * rendered separately and remain collapsed in the popup.
 */
export function installerDownloads(
  platform: Platform,
  architecture: InstallerArchitecture,
): InstallerDownload[] {
  if (platform === "linux" && (architecture === "amd64" || architecture === "arm64")) {
    return downloadFor(
      "tailchrome-install.sh",
      "Use the per-user Linux installer",
    );
  }
  if (platform === "macos" && (architecture === "amd64" || architecture === "arm64")) {
    return downloadFor(
      "tailchrome-helper-macos-user.zip",
      "Download the signed helper app (.zip)",
    );
  }
  if (platform === "windows" && architecture === "amd64") {
    return downloadFor(
      "tailchrome-helper-windows-x64.msi",
      "Download the per-user installer (.msi)",
    );
  }
  if (platform === "windows" && architecture === "arm64") {
    return downloadFor(
      "tailchrome-install.ps1",
      "Copy the native ARM64 PowerShell command",
    );
  }
  return [
    {
      filename: null,
      label: "Open release information",
      url: releasePageURL(),
    },
  ];
}

/** Returns the raw native host asset for advanced fallback use. */
export function binaryFilename(
  platform: Platform,
  architecture: InstallerArchitecture,
): string | null {
  if (platform === "windows" && (architecture === "amd64" || architecture === "arm64")) {
    return `tailscale-browser-ext-windows-${architecture}.exe`;
  }
  if (platform === "linux" && architecture !== "unknown") {
    return `tailscale-browser-ext-linux-${architecture}`;
  }
  if (platform === "macos" && architecture !== "unknown") {
    return `tailscale-browser-ext-darwin-${architecture}`;
  }
  return null;
}

/** Returns the download URL for the raw native host binary. */
export function buildDownloadURL(
  platform: Platform,
  architecture: InstallerArchitecture,
): string {
  const filename = binaryFilename(platform, architecture);
  const url = filename ? releaseAssetURL(filename) : null;
  return url ?? releasePageURL();
}

function supportsInstaller(
  platform: Platform,
  architecture: InstallerArchitecture,
): boolean {
  return (
    (platform === "linux" || platform === "macos" || platform === "windows") &&
    (architecture === "amd64" || architecture === "arm64")
  );
}

function unixInstallCommand(): string | null {
  const tag = currentReleaseTag();
  const scriptURL = releaseAssetURL("tailchrome-install.sh");
  if (!tag || !scriptURL) {
    return null;
  }
  return `curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 '${scriptURL}' | bash -s -- --version '${tag}'`;
}

function powershellInstallCommand(): string | null {
  const tag = currentReleaseTag();
  const scriptURL = releaseAssetURL("tailchrome-install.ps1");
  if (!tag || !scriptURL) {
    return null;
  }
  return `& ([scriptblock]::Create((Invoke-RestMethod -Uri '${scriptURL}'))) -Version '${tag}'`;
}

/**
 * Asks the background service worker to poll native-host discovery after the
 * user starts an installer. The background owns retry timers because opening
 * a download tab closes this popup document.
 */
export function requestNativeHostRetries(
  source: "package" | "fallback" | "manual",
): void {
  sendMessage({ type: "retry-native-host", source });
}

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

/** Renders one install/repair flow for both first setup and recovery. */
export async function renderInstallFlow(
  root: HTMLElement,
  opts: { mode: "install"; state: TailscaleState },
): Promise<void> {
  root.textContent = "";
  const pending = document.createElement("div");
  pending.className = "centered-view-text";
  pending.textContent = "Preparing helper setup…";
  root.appendChild(pending);

  const { platform, architecture } = await getInstallerPlatform();
  if (pending.parentElement !== root) {
    return;
  }

  root.textContent = "";
  const view = document.createElement("div");
  view.className = "view";
  const content = document.createElement("div");
  content.className = "centered-view install-view";

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
    ? "Set up or repair Tailchrome"
    : "Set up Tailchrome";

  const description = document.createElement("p");
  description.className = "centered-view-text";
  description.textContent = helperFailureDescription(
    opts.state.helperFailure?.kind,
  );
  content.append(icon, title, description);

  if (repairProminent) {
    const repair = document.createElement("div");
    repair.className = "helper-registration-repair";
    const repairTitle = document.createElement("strong");
    repairTitle.textContent = "Repair registration for this browser";
    const repairBody = document.createElement("p");
    repairBody.textContent =
      "Use the same per-user setup below to restore registration. Your Tailscale session is not changed.";
    repair.append(repairTitle, repairBody);
    content.appendChild(repair);
  }

  const supported = supportsInstaller(platform, architecture);
  content.appendChild(createPrimaryInstall(platform, architecture));
  if (supported) {
    content.appendChild(createAlternativeInstallDetails(platform, architecture));
  }

  const next = document.createElement("div");
  next.className = "helper-install-next";
  const nextTitle = document.createElement("strong");
  nextTitle.textContent = supported ? "After setup" : "Supported releases";
  const nextBody = document.createElement("p");
  nextBody.textContent = supported
    ? "The installer verifies the helper and registers it for your account. Tailchrome will retry discovery automatically."
    : "Tailchrome cannot identify a supported operating system and architecture, so it will not guess an asset.";
  next.append(nextTitle, nextBody, createDiscoveryRetryButton());
  content.appendChild(next);

  if (opts.state.helperFailure) {
    appendHelperDiagnosticActions(content, opts.state);
  }

  view.appendChild(content);
  renderUiSurfaceFooter(view);
  root.appendChild(view);
}

function createPrimaryInstall(
  platform: Platform,
  architecture: InstallerArchitecture,
): HTMLElement {
  const card = document.createElement("section");
  card.className = "helper-install-primary";

  const heading = document.createElement("h3");
  heading.textContent = primaryHeading(platform, architecture);
  card.appendChild(heading);

  const instructions = document.createElement("p");
  instructions.className = "install-step-body";
  instructions.textContent = primaryInstructions(platform, architecture);
  card.appendChild(instructions);

  const supported = supportsInstaller(platform, architecture);
  const downloads = supported ? installerDownloads(platform, architecture) : [];
  const primary = downloads[0];
  if (!primary) {
    card.appendChild(createReleaseLink());
  } else if (platform === "linux" || (platform === "windows" && architecture === "arm64")) {
    const command =
      platform === "linux" ? unixInstallCommand() : powershellInstallCommand();
    if (command) {
      card.appendChild(createCodeBlock(command));
      if (platform === "windows") {
        card.appendChild(createUnsignedPowerShellHint());
      }
    } else {
      card.appendChild(createReleaseLink());
    }
  } else {
    card.appendChild(createDownloadButton(primary, "package"));
  }

  const hint = document.createElement("p");
  hint.className = "install-step-hint";
  hint.textContent = primaryHint(platform, architecture);
  card.appendChild(hint);
  return card;
}

function primaryHeading(
  platform: Platform,
  architecture: InstallerArchitecture,
): string {
  if (platform === "linux" && (architecture === "amd64" || architecture === "arm64")) {
    return "Install for your user";
  }
  if (platform === "macos" && (architecture === "amd64" || architecture === "arm64")) {
    return "Install the signed app for your user";
  }
  if (platform === "windows" && architecture === "arm64") {
    return "Install natively for Windows ARM64";
  }
  if (platform === "windows" && (architecture === "amd64" || architecture === "arm64")) {
    return "Install for your user";
  }
  return "Choose a supported release";
}

function primaryInstructions(
  platform: Platform,
  architecture: InstallerArchitecture,
): string {
  if (platform === "linux" && (architecture === "amd64" || architecture === "arm64")) {
    return "Copy this version-pinned command into a terminal and run it. No administrator access is required.";
  }
  if (platform === "macos" && (architecture === "amd64" || architecture === "arm64")) {
    return "Download the signed ZIP, open it, then open Tailchrome Helper. It installs and registers the helper for your account.";
  }
  if (platform === "windows" && architecture === "arm64") {
    return "Copy this command into PowerShell. It downloads the release script over HTTPS and verifies the native ARM64 helper.";
  }
  if (platform === "windows" && (architecture === "amd64" || architecture === "arm64")) {
    return "Download and open the MSI. It installs and registers the helper for your account without administrator access.";
  }
  return "Open release information to find a supported installer.";
}

function primaryHint(
  platform: Platform,
  architecture: InstallerArchitecture,
): string {
  if (
    (platform === "linux" || platform === "windows") &&
    (architecture === "amd64" || architecture === "arm64")
  ) {
    return "Rerunning this setup repairs registration too.";
  }
  if (platform === "macos" && (architecture === "amd64" || architecture === "arm64")) {
    return "Reopen Tailchrome Helper to repair setup.";
  }
  return `Runtime platform information for ${platformLabel(platform)} is unsupported.`;
}

function createAlternativeInstallDetails(
  platform: Platform,
  architecture: InstallerArchitecture,
): HTMLElement {
  const details = document.createElement("details");
  details.className = "helper-install-alternatives";
  const summary = document.createElement("summary");
  summary.textContent = "Other installation options";
  details.appendChild(summary);

  if (platform === "linux") {
    if (architecture === "amd64") {
      appendAlternativeHeading(details, "System packages");
      appendDownloadIfAvailable(
        details,
        "tailchrome-helper-linux-amd64.deb",
        "Download Debian/Ubuntu package (.deb)",
      );
      appendDownloadIfAvailable(
        details,
        "tailchrome-helper-linux-x86_64.rpm",
        "Download Fedora/RHEL package (.rpm)",
      );
    }
    appendAdvancedDocs(details);
    return details;
  }

  if (platform === "macos") {
    appendAlternativeHeading(details, "Terminal option");
    appendCommandIfAvailable(details, unixInstallCommand());
    appendAlternativeHeading(details, "System installer");
    appendDownloadIfAvailable(
      details,
      "tailchrome-helper-macos.pkg",
      "Download macOS installer (.pkg)",
    );
    appendAdvancedDocs(details);
    return details;
  }

  if (platform === "windows" && architecture === "amd64") {
    appendAlternativeHeading(details, "PowerShell option");
    const command = powershellInstallCommand();
    appendCommandIfAvailable(details, command);
    if (command) {
      details.appendChild(createUnsignedPowerShellHint());
    }
    appendAdvancedDocs(details);
    return details;
  }

  if (platform === "windows" && architecture === "arm64") {
    appendAlternativeHeading(details, "x64 package (runs under emulation)");
    const explanation = document.createElement("p");
    explanation.className = "install-step-body";
    explanation.textContent =
      "Use this only if the native PowerShell option is unavailable. The MSI contains the x64 helper and Windows runs it through x64 emulation.";
    details.appendChild(explanation);
    appendDownloadIfAvailable(
      details,
      "tailchrome-helper-windows-x64.msi",
      "Download x64 MSI (emulation alternative)",
    );
    appendAdvancedDocs(details);
  }
  return details;
}

function appendAlternativeHeading(container: HTMLElement, text: string): void {
  const heading = document.createElement("strong");
  heading.className = "helper-install-alternative-heading";
  heading.textContent = text;
  container.appendChild(heading);
}

function appendDownloadIfAvailable(
  container: HTMLElement,
  filename: string,
  label: string,
): void {
  const url = releaseAssetURL(filename);
  if (url) {
    container.appendChild(
      createDownloadButton({ filename, label, url }, "package"),
    );
  }
}

function appendCommandIfAvailable(
  container: HTMLElement,
  command: string | null,
): void {
  if (command) {
    container.appendChild(createCodeBlock(command));
  }
}

/**
 * The PowerShell installer requires an Authenticode signature unless the user
 * explicitly opts in. Explain that opt-in here instead of baking it into the
 * command, so signed releases keep rejecting an unsigned substitute (#151).
 */
function createUnsignedPowerShellHint(): HTMLElement {
  const hint = document.createElement("p");
  hint.className = "install-step-hint";
  hint.textContent =
    "If PowerShell stops at “Release is unsigned”, check the release notes. If they say this release's Windows helper is unsigned, run the command again with -AllowUnsigned added at the end.";
  return hint;
}

function appendAdvancedDocs(container: HTMLElement): void {
  const docs = document.createElement("a");
  docs.className = "install-advanced-docs";
  docs.href =
    "https://github.com/dantraynor/tailchrome/blob/main/docs/helper-installation.md";
  docs.target = "_blank";
  docs.rel = "noopener";
  docs.textContent = "Advanced installation and verification details";
  container.appendChild(docs);
}

function createReleaseLink(): HTMLAnchorElement {
  return createDownloadButton(
    {
      filename: null,
      label: "Open release information",
      url: releasePageURL(),
    },
    null,
  );
}

function createDownloadButton(
  download: InstallerDownload,
  source: "package" | "fallback" | null,
): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "btn btn-primary btn-link";
  link.href = download.url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = download.label;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    if (source) {
      requestNativeHostRetries(source);
    }
    chrome.tabs.create({ url: download.url });
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
    retry.textContent = "Retrying…";
    setTimeout(() => {
      retry.disabled = false;
      retry.textContent = "Retry discovery";
    }, 3000);
  });
  return retry;
}

function createCodeBlock(command: string): HTMLElement {
  const codeBlock = document.createElement("div");
  codeBlock.className = "code-block install-command";

  const code = document.createElement("code");
  code.textContent = command;
  codeBlock.appendChild(code);

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "btn btn-ghost code-block-copy";
  copyButton.textContent = "Copy command";
  copyButton.setAttribute("aria-label", "Copy install command");
  copyButton.addEventListener("click", () => {
    requestNativeHostRetries("fallback");
    copyToClipboard(command);
    showToast("Command copied to clipboard");
    copyButton.textContent = "Copied";
    setTimeout(() => {
      copyButton.textContent = "Copy command";
    }, 2000);
  });
  codeBlock.appendChild(copyButton);
  return codeBlock;
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
