import type { TailscaleState } from "@tailchrome/shared/shared/types";
import { TAILSCALE_SERVICE_IP } from "@tailchrome/shared/shared/constants";
import {
  parseCIDR,
  sanitizeMagicDNSSuffix,
  collectSubnetCIDRs,
  shouldProxyState,
} from "@tailchrome/shared/background/proxy-utils";

export class ChromeProxyManager {
  private currentlyEnabled = false;

  apply(state: TailscaleState): void {
    if (!shouldProxyState(state)) {
      if (this.currentlyEnabled) {
        this.clear();
      }
      return;
    }

    const port = state.proxyPort!;
    const magicDNSSuffix = state.magicDNSSuffix;
    const exitNodeActive = state.exitNode !== null;
    const subnets = collectSubnetCIDRs(state.peers);

    const pacScript = this.generatePACScript(
      port,
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
    magicDNSSuffix: string | null | undefined,
    exitNodeActive: boolean,
    subnets: string[]
  ): string {
    const proxy = `SOCKS5 127.0.0.1:${port}`;

    // Build subnet checks for isInNet()
    const subnetChecks = subnets
      .map((cidr) => {
        const parsed = parseCIDR(cidr, "string");
        if (!parsed) return null;
        return `    if (isInNet(host, "${parsed.network}", "${parsed.mask}")) return "${proxy}";`;
      })
      .filter((line): line is string => line !== null)
      .join("\n");

    const safeDNSSuffix = sanitizeMagicDNSSuffix(magicDNSSuffix);

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
}
