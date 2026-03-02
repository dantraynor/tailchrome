import { copyToClipboard, showToast, detectPlatform } from "../utils";

/**
 * Renders the native host not-installed view.
 * Shows setup instructions with a platform-detected install command.
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
    "Tailscale needs a helper program to connect your browser to your tailnet. " +
    "Run the following command to install it.";

  content.appendChild(icon);
  content.appendChild(title);
  content.appendChild(description);

  // Install command
  const platform = detectPlatform();
  const extensionID = chrome.runtime.id;
  const installCmd = buildInstallCommand(platform, extensionID);

  const codeBlock = document.createElement("div");
  codeBlock.className = "code-block";

  const code = document.createElement("code");
  code.textContent = installCmd;
  codeBlock.appendChild(code);

  // Copy button inside the code block
  const copyBtn = document.createElement("button");
  copyBtn.className = "btn btn-ghost code-block-copy";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => {
    copyToClipboard(installCmd);
    showToast("Command copied to clipboard");
    copyBtn.textContent = "Copied!";
    setTimeout(() => {
      copyBtn.textContent = "Copy";
    }, 2000);
  });
  codeBlock.appendChild(copyBtn);
  content.appendChild(codeBlock);

  // Extra help text
  const helpText = document.createElement("p");
  helpText.className = "centered-view-text";
  helpText.style.fontSize = "var(--font-size-xs)";
  helpText.style.marginTop = "0";
  helpText.textContent =
    "Your extension ID can also be found at chrome://extensions with developer mode enabled.";

  content.appendChild(helpText);
  view.appendChild(content);

  root.appendChild(view);
}

/**
 * Builds the platform-appropriate install command string.
 */
function buildInstallCommand(
  platform: "macos" | "linux" | "windows" | "unknown",
  extensionID: string,
): string {
  const flag = `-install C${extensionID}`;

  if (platform === "windows") {
    return `curl -Lo tailscale-browser-ext.exe https://github.com/tailscale/tailchrome/releases/latest/download/tailscale-browser-ext-windows-amd64.exe\n.\\tailscale-browser-ext.exe ${flag}`;
  }

  const arch = "$(uname -m | sed 's/x86_64/amd64/')";

  if (platform === "linux") {
    return `curl -Lo tailscale-browser-ext https://github.com/tailscale/tailchrome/releases/latest/download/tailscale-browser-ext-linux-amd64 && chmod +x tailscale-browser-ext && ./tailscale-browser-ext ${flag}`;
  }

  // macOS (default)
  return `curl -Lo tailscale-browser-ext https://github.com/tailscale/tailchrome/releases/latest/download/tailscale-browser-ext-darwin-${arch} && chmod +x tailscale-browser-ext && ./tailscale-browser-ext ${flag}`;
}
