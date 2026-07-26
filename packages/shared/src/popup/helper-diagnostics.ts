import type { TailscaleState } from "../types";
import {
  formatHelperDiagnosticReport,
  type HelperDiagnosticBrowserFamily,
} from "../helper-diagnostics";
import { copyToClipboard, showToast } from "./utils";

export const HELPER_DIAGNOSTIC_FILENAME =
  "tailchrome-helper-diagnostics.txt";

export async function buildCurrentHelperDiagnosticReport(
  state: TailscaleState,
): Promise<string> {
  const [platform, manifest] = await Promise.all([
    chrome.runtime.getPlatformInfo(),
    Promise.resolve(chrome.runtime.getManifest()),
  ]);
  const extensionVersion = manifest.version;
  const browserFamily: HelperDiagnosticBrowserFamily =
    manifest.browser_specific_settings?.gecko ? "firefox" : "chromium";

  return formatHelperDiagnosticReport({
    state,
    extensionVersion,
    releaseVersion: extensionVersion,
    platform: {
      os: platform.os,
      arch: platform.arch,
    },
    browserFamily,
  });
}

export function copyHelperDiagnosticReport(report: string): Promise<void> {
  return copyToClipboard(report);
}

export function exportHelperDiagnosticReport(report: string): void {
  const blob = new Blob([report], { type: "text/plain;charset=utf-8" });
  const objectURL = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectURL;
  link.download = HELPER_DIAGNOSTIC_FILENAME;
  link.hidden = true;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(objectURL);
  }
}

export function appendHelperDiagnosticActions(
  container: HTMLElement,
  state: TailscaleState,
): void {
  const actions = document.createElement("div");
  actions.className = "helper-diagnostic-actions";

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "btn btn-secondary";
  copyButton.textContent = "Copy diagnostic report";
  copyButton.addEventListener("click", () => {
    copyButton.disabled = true;
    void buildCurrentHelperDiagnosticReport(state)
      .then(copyHelperDiagnosticReport)
      .then(() => showToast("Diagnostic report copied."))
      .catch(() =>
        showToast("Could not copy the diagnostic report.", "error"),
      )
      .finally(() => {
        copyButton.disabled = false;
      });
  });

  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.className = "btn btn-secondary";
  exportButton.textContent = "Export diagnostic report";
  exportButton.addEventListener("click", () => {
    exportButton.disabled = true;
    void buildCurrentHelperDiagnosticReport(state)
      .then(exportHelperDiagnosticReport)
      .then(() => showToast("Diagnostic report exported."))
      .catch(() =>
        showToast("Could not export the diagnostic report.", "error"),
      )
      .finally(() => {
        exportButton.disabled = false;
      });
  });

  actions.append(copyButton, exportButton);
  container.appendChild(actions);
}
