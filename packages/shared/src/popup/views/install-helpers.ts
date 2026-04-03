import { detectPlatform } from "../utils";

const RELEASE_BASE =
  "https://github.com/dantraynor/tailchrome/releases/latest/download";

/**
 * Returns the filename of the native host binary for the detected platform.
 */
export function binaryFilename(
  platform: "macos" | "linux" | "windows" | "unknown",
): string | null {
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
export function buildDownloadURL(
  platform: "macos" | "linux" | "windows" | "unknown",
): string {
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
export function buildRunCommand(
  platform: "macos" | "linux" | "windows" | "unknown",
): string | null {
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
