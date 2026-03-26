import type { PeerInfo, TailscaleState } from "../types";

// Tailscale CGNAT range: 100.64.0.0/10
export const CGNAT_NETWORK = 0x64400000;
export const CGNAT_MASK = 0xffc00000;

/** Convert a dotted-decimal IP string to a 32-bit unsigned integer, or null if invalid. */
export function ipToNum(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let num = 0;
  for (const part of parts) {
    const octet = parseInt(part, 10);
    if (isNaN(octet) || octet < 0 || octet > 255) return null;
    num = (num << 8) | octet;
  }
  return num >>> 0;
}

/** Convert a 32-bit unsigned integer back to dotted-decimal IP string. */
function numToIP(num: number): string {
  return [
    (num >>> 24) & 0xff,
    (num >>> 16) & 0xff,
    (num >>> 8) & 0xff,
    num & 0xff,
  ].join(".");
}

/** Parse a CIDR string, returning numeric network/mask values. */
export function parseCIDR(cidr: string): { network: number; mask: number } | null;
/** Parse a CIDR string, returning string network/mask values. */
export function parseCIDR(
  cidr: string,
  format: "string"
): { network: string; mask: string } | null;
export function parseCIDR(
  cidr: string,
  format?: "string"
): { network: number; mask: number } | { network: string; mask: string } | null {
  const parts = cidr.split("/");
  if (parts.length !== 2) return null;

  const networkStr = parts[0]!;
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(networkStr)) return null;

  const prefixLen = parseInt(parts[1]!, 10);
  if (isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) return null;

  const networkNum = ipToNum(networkStr);
  if (networkNum === null) return null;

  const maskNum = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;

  if (format === "string") {
    return { network: networkStr, mask: numToIP(maskNum) };
  }
  return { network: networkNum, mask: maskNum };
}

/**
 * Sanitize a MagicDNS suffix: strip trailing dot, reject strings
 * containing unsafe characters. Returns empty string if invalid.
 */
export function sanitizeMagicDNSSuffix(suffix: string | null | undefined): string {
  if (!suffix) return "";
  const stripped = suffix.replace(/\.$/, "");
  return /^[a-zA-Z0-9.\-]+$/.test(stripped) ? stripped : "";
}

/** Collect all subnet CIDRs from peers that are subnet routers. */
export function collectSubnetCIDRs(peers: PeerInfo[]): string[] {
  const cidrs: string[] = [];
  for (const peer of peers) {
    if (peer.isSubnetRouter && peer.subnets.length > 0) {
      cidrs.push(...peer.subnets);
    }
  }
  return cidrs;
}

/** Return true if the proxy should be active given the current state. */
export function shouldProxyState(state: TailscaleState): boolean {
  return (
    state.proxyEnabled &&
    state.proxyPort !== null &&
    state.backendState === "Running"
  );
}
