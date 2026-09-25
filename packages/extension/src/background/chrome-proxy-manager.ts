import { ChromeProxyAuth, PROXY_AUTH_PROBE_HOST } from "./chrome-proxy-auth";
import type {
  ProxySessionCredentials,
  DomainSplitConfig,
  TailscaleState,
  RoutingHealth,
} from "@tailchrome/shared/types";
import {
  TAILSCALE_IPV6_PREFIX,
  TAILSCALE_SERVICE_IP,
} from "@tailchrome/shared/constants";
import {
  parseCIDR,
  sanitizeMagicDNSSuffix,
  sanitizeDomain,
  sanitizeDNSRoutes,
} from "@tailchrome/shared/background/proxy-utils";

import {
  policyFromState,
  BLOCKED_PROXY_PORT,
} from "@tailchrome/shared/background/routing-protection";

export class ChromeProxyManager {
  private readonly auth = new ChromeProxyAuth();

  setProxySession(session: ProxySessionCredentials | null): void {
    if (this.auth.set(session)) {
      this.sessionEpoch += 1;
      this.appliedKey = "";
      this.errorKey = "";
    }
  }

  private desired: chrome.proxy.ProxyConfig | null = null;
  private authPending: chrome.proxy.ProxyConfig | null = null;
  private desiredKey = "";
  private appliedKey = "";
  private inFlight = false;
  private authRoutingPending = false;
  private errorKey = "";
  private changeEpoch = 0;
  private healthListener: ((health: RoutingHealth) => void) | null = null;
  private desiredHealth: RoutingHealth = { status: "inactive", message: "" };
  private activePort = 0;
  private sessionEpoch = 0;

  constructor() {
    chrome.proxy.settings.onChange.addListener((details) => {
      this.changeEpoch += 1;
      if (this.inFlight || !this.desired) return;
      if (
        details.levelOfControl === "controlled_by_other_extensions" ||
        details.levelOfControl === "not_controllable"
      ) {
        this.appliedKey = "";
        this.report({
          status: "conflicted",
          message:
            "Browser routing is controlled by another extension or a browser policy.",
        });
      } else if (
        this.desired &&
        !sameProxyConfig(details.value, this.desired)
      ) {
        this.appliedKey = "";
        this.flush();
      } else {
        this.flush();
      }
    });
    chrome.proxy.onProxyError.addListener((details) => {
      if (!this.desired) return;
      if (this.authRoutingPending && details.fatal && details.error === "net::ERR_PROXY_CONNECTION_FAILED") {
        // The temporary auth PAC deliberately sends protected requests to a
        // closed port. Its failures must not latch against the desired PAC.
        // The probe itself reports a real helper/authentication failure.
        return;
      }
      if (details.fatal && details.error === "net::ERR_TUNNEL_CONNECTION_FAILED") {
        // Chrome aborted one CONNECT request, not the installed proxy policy.
        // Browser-internal requests can be hidden from our auth listener. Keep
        // that request failed without latching a global routing-health failure.
        return;
      }
      this.errorKey = this.desiredKey;
      this.appliedKey = "";
      this.report({
        status: details.fatal ? "blocked" : "unavailable",
        message: details.fatal
          ? "The proxy is unavailable — protected browsing is blocked."
          : "Browser routing failed. Traffic may use your normal connection.",
      });
    });
  }

  setRoutingHealthListener(listener: (health: RoutingHealth) => void): void {
    this.healthListener = listener;
  }

  apply(state: TailscaleState): void {
    const policy = policyFromState(state);
    if (policy.mode === "direct") {
      this.clear();
      return;
    }
    const authenticationMissing = !this.auth.hasSession(policy.proxyPort ?? 0);
    const blocked = policy.mode === "blocked" || authenticationMissing;
    const port = blocked ? BLOCKED_PROXY_PORT : policy.proxyPort!;
    this.activePort = blocked ? 0 : port;
    this.desiredHealth = blocked
      ? {
          status: "blocked",
          message: authenticationMissing && policy.mode === "active"
            ? "Helper authentication unavailable — protected browsing is blocked."
            : policy.selectedExitNodeID
            ? "Exit node unavailable — protected browsing is blocked."
            : "Connection unavailable — tailnet browsing is blocked.",
        }
      : { status: "active", message: "" };
    const config = (proxyPort: number, probePort?: number): chrome.proxy.ProxyConfig => ({
      mode: "pac_script",
      pacScript: {
        mandatory: true,
        data: this.generatePACScript(
          proxyPort,
          policy.magicDNSSuffix,
          policy.blockAll || policy.selectedExitNodeID !== null,
          policy.subnetCIDRs,
          policy.domainSplit.mode,
          sanitizeSplitDomains(policy.domainSplit),
          policy.shortNames,
          policy.dnsRoutes,
          probePort,
        ),
      },
    });
    this.desired = config(port);
    this.authPending = blocked ? null : config(BLOCKED_PROXY_PORT, port);
    const nextKey = JSON.stringify(this.desired);
    if (nextKey !== this.desiredKey) this.errorKey = "";
    this.desiredKey = nextKey;
    this.flush();
  }

  clear(): void {
    this.desired = null;
    this.authPending = null;
    if (this.desiredKey !== "clear") this.errorKey = "";
    this.desiredKey = "clear";
    this.desiredHealth = { status: "inactive", message: "" };
    this.flush();
  }

  private report(health: RoutingHealth): void {
    this.healthListener?.(health);
  }

  private flush(): void {
    if (!this.desiredKey || this.inFlight || this.errorKey === this.desiredKey)
      return;
    if (this.appliedKey === this.desiredKey) {
      this.report(this.desiredHealth);
      return;
    }
    this.inFlight = true;
    const key = this.desiredKey;
    const sessionEpoch = this.sessionEpoch;
    const port = this.activePort;
    const warming = this.desiredHealth.status === "active" && !this.auth.isReadyFor(port);
    if (warming) this.authRoutingPending = true;
    // During authentication only our reserved probe destination reaches the
    // helper. All other protected routes retain their fail-closed behavior.
    const value = warming ? this.authPending : this.desired;
    const fail = (message: string, conflicted = false): void => {
      this.appliedKey = "";
      // Keep reentrant state notifications from immediately retrying a rejection.
      this.report({
        status: conflicted ? "conflicted" : "unavailable",
        message,
      });
      this.inFlight = false;
      if (key !== this.desiredKey) this.flush();
    };
    chrome.proxy.settings.get({ incognito: false }, (current) => {
      if (key !== this.desiredKey) {
        this.inFlight = false;
        this.flush();
        return;
      }
      if (chrome.runtime.lastError) {
        fail("Could not check browser routing.");
        return;
      }
      if (
        value &&
        (current.levelOfControl === "not_controllable" ||
          current.levelOfControl === "controlled_by_other_extensions")
      ) {
        fail(
          "Browser routing is controlled by another extension or a browser policy.",
          true,
        );
        return;
      }
      const done = (): void => {
        if (chrome.runtime.lastError) {
          fail("The browser rejected the routing settings.");
          return;
        }
        const verify = (): void => {
          const epoch = this.changeEpoch;
          chrome.proxy.settings.get({ incognito: false }, (effective) => {
            if (epoch !== this.changeEpoch) {
              verify();
              return;
            }
            if (chrome.runtime.lastError) {
              fail("Could not verify browser routing.");
              return;
            }
            if (
              value &&
              (effective.levelOfControl !== "controlled_by_this_extension" ||
                !sameProxyConfig(effective.value, value))
            ) {
              fail(
                "Browser routing is controlled by another extension or a browser policy.",
                true,
              );
              return;
            }
            if (warming) {
              if (key === this.desiredKey) this.report({ status: "blocked", message: "Preparing helper authentication — protected browsing is blocked." });
              void this.auth.prepare(port).then(() => {
                this.inFlight = false;
                this.flush();
              }, () => {
                if (key !== this.desiredKey || sessionEpoch !== this.sessionEpoch) {
                  this.inFlight = false;
                  this.flush();
                  return;
                }
                this.errorKey = key;
                fail("Helper authentication failed — protected browsing is blocked.");
              });
              return;
            }
            // Keep ignoring the temporary route's connection failures until
            // Chrome has confirmed its replacement, including after the probe
            // succeeds while settings callbacks are still pending.
            this.authRoutingPending = false;
            this.appliedKey = key;
            if (key === this.desiredKey) this.report(this.desiredHealth);
            this.inFlight = false;
            if (key !== this.desiredKey) this.flush();
          });
        };
        verify();
      };
      if (value) chrome.proxy.settings.set({ value, scope: "regular" }, done);
      else chrome.proxy.settings.clear({ scope: "regular" }, done);
    });
  }

  private generatePACScript(
    port: number,
    magicDNSSuffix: string | null | undefined,
    exitNodeActive: boolean,
    subnets: string[],
    splitMode: "bypass" | "only",
    splitDomains: string[],
    shortNames: string[],
    dnsRoutes: string[],
    probePort?: number,
  ): string {
    const proxy = `PROXY 127.0.0.1:${port}`;

    const subnetChecks = subnets
      .map((cidr) => {
        const parsed = parseCIDR(cidr, "string");
        if (!parsed) return null;
        return `    if (isIPv4 && isInNet(host, "${parsed.network}", "${parsed.mask}")) return "${proxy}";`;
      })
      .filter((line): line is string => line !== null)
      .join("\n");

    const safeDNSSuffix = sanitizeMagicDNSSuffix(magicDNSSuffix).toLowerCase();
    const dnsChecks = [
      ...sanitizeDNSRoutes(shortNames).filter((name) => !name.includes("."))
        .map((name) => `host === "${name}"`),
      ...sanitizeDNSRoutes(dnsRoutes)
        .map((domain) => `(host === "${domain}" || dnsDomainIs(host, ".${domain}"))`),
    ].join(" || ");

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
${probePort ? `  if (host === "${PROXY_AUTH_PROBE_HOST}") return "PROXY 127.0.0.1:${probePort}";` : ""}
  host = host.toLowerCase().replace(/\\.$/, "");
  var proxy = "${proxy}";
  var isIPv4 = /^\\d{1,3}(?:\\.\\d{1,3}){3}$/.test(host);

  if (host === "${TAILSCALE_SERVICE_IP}") return proxy;
${safeDNSSuffix ? `  if (dnsDomainIs(host, ".${safeDNSSuffix}") || host === "${safeDNSSuffix}") return proxy;` : "  // No MagicDNS suffix configured"}
${dnsChecks ? `  if (${dnsChecks}) return proxy;` : "  // No additional DNS routes"}
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

function sameProxyConfig(
  actual: chrome.proxy.ProxyConfig,
  expected: chrome.proxy.ProxyConfig,
): boolean {
  return (
    actual.mode === expected.mode &&
    actual.pacScript?.data === expected.pacScript?.data &&
    (actual.pacScript?.mandatory === true) ===
      (expected.pacScript?.mandatory === true)
  );
}
