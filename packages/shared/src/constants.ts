export const TAILSCALE_SERVICE_IP = "100.100.100.100";
export const KEEPALIVE_INTERVAL_MS = 25_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const ADMIN_URL = "https://login.tailscale.com/admin";
/** Tailscale's default coordination/control plane URL. Empty `controlURL` in prefs means this. */
export const DEFAULT_CONTROL_URL = "https://controlplane.tailscale.com";
/**
 * Origins that mean "Tailscale's default control plane" for a `controlURL`.
 * Single source of truth for both `isCustomControlURL` and `DEFAULT_LOGIN_ORIGINS`.
 * Keep in sync with `defaultControlURLOrigin` / `defaultLoginURLOrigin` in
 * `host/host.go`, which classifies the same set on the Go side.
 */
export const DEFAULT_CONTROL_URL_ORIGINS: readonly string[] = [
  new URL(DEFAULT_CONTROL_URL).origin,
  "https://login.tailscale.com",
];
/**
 * Origins whose login URLs we open in a tab when using the default server.
 * Superset of the control-plane origins (also covers tailscale.com landing pages).
 */
export const DEFAULT_LOGIN_ORIGINS: readonly string[] = [
  ...DEFAULT_CONTROL_URL_ORIGINS,
  "https://tailscale.com",
];
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
    return !DEFAULT_CONTROL_URL_ORIGINS.includes(new URL(controlURL).origin);
  } catch {
    return false;
  }
}

/**
 * Returns true when a non-empty coordination-server URL is well-formed
 * (an http/https URL with a host). Mirrors `isValidControlURL` in host/host.go
 * so the popup, background, and native host agree on what is acceptable.
 */
export function isValidControlURL(controlURL: string): boolean {
  try {
    const u = new URL(controlURL);
    return (u.protocol === "http:" || u.protocol === "https:") && u.host !== "";
  } catch {
    return false;
  }
}
