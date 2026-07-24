import type { DomainSplitConfig, TailscaleState } from "@tailchrome/shared/types";
import {
  TAILSCALE_IPV6_PREFIX,
  TAILSCALE_SERVICE_IP,
} from "@tailchrome/shared/constants";
import {
  parseCIDR,
  sanitizeMagicDNSSuffix,
  sanitizeDomain,
  collectSubnetCIDRs,
  shouldProxyState,
} from "@tailchrome/shared/background/proxy-utils";

export class ChromeProxyManager {
  private currentlyEnabled = false;
  private lastProxyKey = "";
  private reconciledBrowserState = false;

  apply(state: TailscaleState): void {
    if (!shouldProxyState(state)) {
      // A service-worker restart loses the in-memory enabled flag while Chrome
      // can retain the PAC setting. Reconcile browser state once on startup.
      if (this.currentlyEnabled || !this.reconciledBrowserState) {
        this.clear();
      }
      this.reconciledBrowserState = true;
      return;
    }

    this.reconciledBrowserState = true;

    const port = state.proxyPort!;
    const magicDNSSuffix = state.magicDNSSuffix;
    const exitNodeActive = state.exitNode !== null;
    const subnets = collectSubnetCIDRs(state.peers);
    const splitDomains = sanitizeSplitDomains(state.domainSplit);
    const splitMode = state.domainSplit.mode;

    // Skip regeneration if proxy-relevant fields haven't changed
    const proxyKey = `${port}:${magicDNSSuffix ?? ""}:${exitNodeActive}:${[...subnets].sort().join(",")}:${splitMode}:${splitDomains.join(",")}`;
    if (proxyKey === this.lastProxyKey) {
      return;
    }
    this.lastProxyKey = proxyKey;

    const pacScript = this.generatePACScript(
      port,
      magicDNSSuffix,
      exitNodeActive,
      subnets,
      splitMode,
      splitDomains,
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
            chrome.runtime.lastError.message,
          );
        }
      },
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
            chrome.runtime.lastError.message,
          );
        }
      },
    );
    this.currentlyEnabled = false;
    this.lastProxyKey = "";
  }

  private generatePACScript(
    port: number,
    magicDNSSuffix: string | null | undefined,
    exitNodeActive: boolean,
    subnets: string[],
    splitMode: "bypass" | "only",
    splitDomains: string[],
  ): string {
    const proxy = `SOCKS5 127.0.0.1:${port}`;

    const subnetChecks = subnets
      .map((cidr) => {
        const parsed = parseCIDR(cidr, "string");
        if (!parsed) return null;
        return `    if (isIPv4 && isInNet(host, "${parsed.network}", "${parsed.mask}")) return "${proxy}";`;
      })
      .filter((line): line is string => line !== null)
      .join("\n");

    const safeDNSSuffix = sanitizeMagicDNSSuffix(magicDNSSuffix);

    const domainChecks =
      splitDomains
        .map((d) => `(host === "${d}" || dnsDomainIs(host, ".${d}"))`)
        .join(" || ") || "false";

    let catchAll: string;
    if (!exitNodeActive) {
      catchAll = '  return "DIRECT";';
    } else if (splitMode === "only") {
      // Only mode: empty list means nothing should leave through the exit node.
      catchAll = `  if (${domainChecks}) return proxy;\n  return "DIRECT";`;
    } else if (splitDomains.length > 0) {
      catchAll = `  if (${domainChecks}) return "DIRECT";\n  return proxy;`;
    } else {
      catchAll = "  return proxy;";
    }

    return `function FindProxyForURL(url, host) {
  var proxy = "${proxy}";
  var isIPv4 = /^\\d{1,3}(?:\\.\\d{1,3}){3}$/.test(host);

  if (host === "${TAILSCALE_SERVICE_IP}") return proxy;
${safeDNSSuffix ? `  if (dnsDomainIs(host, ".${safeDNSSuffix}") || host === "${safeDNSSuffix}") return proxy;` : "  // No MagicDNS suffix configured"}
  if (host.toLowerCase().indexOf("${TAILSCALE_IPV6_PREFIX}") === 0) return proxy;
  if (isIPv4 && isInNet(host, "100.64.0.0", "255.192.0.0")) return proxy;

${subnetChecks || "  // No subnet routes"}

${catchAll}
}`;
  }
}

function sanitizeSplitDomains(config: DomainSplitConfig): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of config.domains) {
    const cleaned = sanitizeDomain(raw);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}
