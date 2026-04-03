import { copyToClipboard, showToast, detectPlatform } from "../utils";
import { EXPECTED_HOST_VERSION } from "../../constants";
import { buildDownloadURL, buildRunCommand } from "./install-helpers";

/**
 * Renders the native host version-mismatch view.
 * Prompts the user to download and run the latest host binary.
 */
export function renderNeedsUpdate(root: HTMLElement, hostVersion: string | null): void {
  root.textContent = "";
  const view = document.createElement("div");
  view.className = "view";

  const content = document.createElement("div");
  content.className = "centered-view";

  const icon = document.createElement("div");
  icon.className = "centered-view-icon";
  icon.textContent = "\u26A0\uFE0F"; // warning sign

  const title = document.createElement("h2");
  title.className = "centered-view-title";
  title.textContent = "Update Required";

  const description = document.createElement("p");
  description.className = "centered-view-text";
  description.textContent =
    "The Tailscale helper program needs to be updated to work with this version of the extension.";

  content.appendChild(icon);
  content.appendChild(title);
  content.appendChild(description);

  // Version info
  const versionInfo = document.createElement("p");
  versionInfo.className = "centered-view-text";
  versionInfo.style.fontSize = "var(--font-sm)";
  versionInfo.style.opacity = "0.7";
  const currentLabel = hostVersion ?? "unknown";
  versionInfo.textContent = `Installed: ${currentLabel} \u2192 Required: ${EXPECTED_HOST_VERSION}`;
  content.appendChild(versionInfo);

  // Download button
  const platform = detectPlatform();
  const downloadURL = buildDownloadURL(platform);

  const downloadBtn = document.createElement("a");
  downloadBtn.className = "btn btn-primary btn-lg";
  downloadBtn.textContent = "Download Update";
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
    stepText.textContent = "Then run it to complete the update:";
    content.appendChild(stepText);

    const codeBlock = document.createElement("div");
    codeBlock.className = "code-block";

    const code = document.createElement("code");
    code.textContent = runCmd;
    codeBlock.appendChild(code);

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
