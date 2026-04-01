/**
 * Per-device custom URL/port storage.
 *
 * Stores a mapping of peer ID → custom value in chrome.storage.local.
 * Values can be a port number (e.g. "8080") or a full URL with optional
 * {host} placeholder (e.g. "https://{host}:8443/admin").
 */

type CustomUrls = Record<string, string>;

let cache: CustomUrls = {};

/** Load custom URLs from storage into the in-memory cache. Call once at popup init. */
export async function loadCustomUrls(): Promise<CustomUrls> {
  const result = await chrome.storage.local.get("customUrls");
  cache = (result["customUrls"] as CustomUrls) || {};
  return cache;
}

/** Get the custom URL/port for a peer, or undefined if none is set. */
export function getCustomUrl(peerId: string): string | undefined {
  return cache[peerId];
}

/** Set a custom URL/port for a peer and persist to storage. */
export async function setCustomUrl(peerId: string, value: string): Promise<void> {
  cache[peerId] = value;
  await chrome.storage.local.set({ customUrls: cache });
}

/** Clear the custom URL/port for a peer and persist to storage. */
export async function clearCustomUrl(peerId: string): Promise<void> {
  delete cache[peerId];
  await chrome.storage.local.set({ customUrls: cache });
}

/**
 * Resolve the final URL for the "Open" button.
 *
 * - No custom value: `http://{host}/`
 * - Numeric value (port): `http://{host}:{port}/`
 * - Full URL: returned as-is, with `{host}` replaced by the actual host
 */
export function resolveOpenUrl(host: string, customValue?: string): string {
  if (!customValue) return `http://${host}/`;
  if (/^\d+$/.test(customValue)) return `http://${host}:${customValue}/`;
  return customValue.replace(/\{host\}/g, host);
}
