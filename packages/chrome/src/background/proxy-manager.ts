import type { TailscaleState } from "@tailchrome/shared/shared/types";
import { TAILSCALE_SERVICE_IP } from "@tailchrome/shared/shared/constants";

export class ChromeProxyManager {
  private currentlyEnabled = false;

  apply(state: TailscaleState): void {
    const shouldProxy =
      state.proxyEnabled &&
      state.proxyPort !== null &&
      state.backendState === "Running";

    if (!shouldProxy) {
      if (this.currentlyEnabled) {
        this.clear();
      }
      return;
    }

    const port = state.proxyPort!;
    const tailnet = state.tailnet ?? "";
    const tailscaleIPs = state.selfNode?.tailscaleIPs ?? [];
    const magicDNSSuffix = state.magicDNSSuffix ?? "";
    const exitNodeActive = state.exitNode !== null;

    // Collect subnet routes from all peers that are subnet routers
    const subnets: string[] = [];
    for (const peer of state.peers) {
      if (peer.isSubnetRouter && peer.subnets.length > 0) {
        subnets.push(...peer.subnets);
      }
    }

    const pacScript = this.generatePACScript(
      port,
      tailnet,
      tailscaleIPs,
      magicDNSSuffix,
      exitNodeActive,
      subnets
    );

    chrome.proxy.settings.set(
      {
        value: {
          mode: "pac_script",
          pacScript: {
            data: pacScript,
          },
        },
        scope: "regular",
      },
      () => {
        if (chrome.runtime.lastError) {
          console.error(
            "[ProxyManager] Failed to set proxy:",
            chrome.runtime.lastError.message
          );
        }
      }
    );

    this.currentlyEnabled = true;
  }

  clear(): void {
    chrome.proxy.settings.set(
      {
        value: { mode: "direct" },
        scope: "regular",
      },
      () => {
        if (chrome.runtime.lastError) {
          console.error(
            "[ProxyManager] Failed to clear proxy:",
            chrome.runtime.lastError.message
          );
        }
      }
    );
    this.currentlyEnabled = false;
  }

  private generatePACScript(
    port: number,
    tailnet: string,
    tailscaleIPs: string[],
    magicDNSSuffix: string,
    exitNodeActive: boolean,
    subnets: string[]
  ): string {
    const proxy = `SOCKS5 127.0.0.1:${port}`;

    // Build subnet checks for isInNet()
    const subnetChecks = subnets
      .map((cidr) => {
        const parsed = this.parseCIDR(cidr);
        if (!parsed) return null;
        return `    if (isInNet(host, "${parsed.network}", "${parsed.mask}")) return "${proxy}";`;
      })
      .filter((line): line is string => line !== null)
      .join("\n");

    // Sanitize magicDNSSuffix: strip trailing dot, reject unsafe characters
    const dnsSuffix = magicDNSSuffix.replace(/\.$/, "");
    const safeDNSSuffix = /^[a-zA-Z0-9.\-]+$/.test(dnsSuffix) ? dnsSuffix : "";

    const script = `function FindProxyForURL(url, host) {
  var proxy = "${proxy}";

  // Always proxy Tailscale service IP
  if (host === "${TAILSCALE_SERVICE_IP}") return proxy;

  // Proxy all Tailscale CGNAT IPs (100.64.0.0/10)
  if (isInNet(host, "100.64.0.0", "255.192.0.0")) return proxy;

  // Proxy MagicDNS names
${safeDNSSuffix ? `  if (dnsDomainIs(host, ".${safeDNSSuffix}") || host === "${safeDNSSuffix}") return proxy;` : "  // No MagicDNS suffix configured"}

  // Proxy subnet router ranges
${subnetChecks || "  // No subnet routes"}

  // If exit node is active, proxy ALL traffic
${exitNodeActive ? `  return proxy;` : `  return "DIRECT";`}
}`;

    return script;
  }

  /**
   * Parse a CIDR notation (e.g. "10.0.0.0/24") into network address and subnet mask.
   */
  private parseCIDR(
    cidr: string
  ): { network: string; mask: string } | null {
    const parts = cidr.split("/");
    if (parts.length !== 2) return null;

    const network = parts[0]!;
    // Validate network is a dotted-decimal IP
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(network)) return null;
    const prefixLen = parseInt(parts[1]!, 10);
    if (isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) return null;

    // Convert prefix length to subnet mask
    const maskNum =
      prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
    const mask = [
      (maskNum >>> 24) & 0xff,
      (maskNum >>> 16) & 0xff,
      (maskNum >>> 8) & 0xff,
      maskNum & 0xff,
    ].join(".");

    return { network, mask };
  }
}
