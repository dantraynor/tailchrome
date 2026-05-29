export const TAILSCALE_SERVICE_IP = "100.100.100.100";
export const KEEPALIVE_INTERVAL_MS = 25_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const ADMIN_URL = "https://login.tailscale.com/admin";
/** Tailscale's default coordination/control plane URL. Empty `controlURL` in prefs means this. */
export const DEFAULT_CONTROL_URL = "https://controlplane.tailscale.com";
const DEFAULT_CONTROL_URL_ORIGINS = new Set([
  new URL(DEFAULT_CONTROL_URL).origin,
  "https://login.tailscale.com",
]);
/** Tailchrome project on GitHub (footer, diagnostics toast). */
export const TAILCHROME_PROJECT_URL = "https://github.com/dantraynor/tailchrome";
export const EXPECTED_HOST_VERSION = "0.1.11";

/**
 * Returns true when the given prefs.controlURL points at a custom coordination
 * server (e.g. Headscale). Empty / missing / Tailscale's default URLs return false.
 */
export function isCustomControlURL(controlURL: string | undefined | null): boolean {
  if (!controlURL) return false;
  try {
    return !DEFAULT_CONTROL_URL_ORIGINS.has(new URL(controlURL).origin);
  } catch {
    return false;
  }
}
