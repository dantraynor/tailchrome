import type { RoutingPolicy, StatusUpdate, TailscaleState } from "../types";
import { normalizeDomainSplit } from "./domain-split";
import {
  collectSubnetCIDRs,
  parseCIDR,
  sanitizeMagicDNSSuffix,
  shouldProxyState,
} from "./proxy-utils";

export const ROUTING_STORAGE_KEY = "routingProtectionV1";
// Use a closed loopback endpoint, never a previous helper's reusable port.
export const BLOCKED_PROXY_PORT = 1;

type Snapshot = Omit<RoutingPolicy, "mode" | "proxyPort"> & { scope: string };
interface SavedRouting {
  active: Snapshot | null;
  profiles: Snapshot[];
  released?: boolean;
  transitioning?: boolean;
  pendingExit?: string | null;
  pendingDisconnect?: boolean;
}

function strings(value: unknown, valid: (s: string) => boolean): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter((s): s is string => typeof s === "string" && valid(s)),
        ),
      ]
    : [];
}
function snapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.scope !== "string" || raw.scope.length > 4096) return null;
  if (
    raw.selectedExitNodeID !== null &&
    (typeof raw.selectedExitNodeID !== "string" ||
      raw.selectedExitNodeID.length > 256)
  )
    return null;
  const subnetCIDRs = strings(
    raw.subnetCIDRs,
    (s) => /\/\d{1,2}$/.test(s) && parseCIDR(s) !== null,
  );
  const shortNames = strings(raw.shortNames, (s) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s),
  );
  const dnsRoutes = strings(
    raw.dnsRoutes,
    (s) =>
      s.length < 254 &&
      s
        .split(".")
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
  );
  for (const [key, clean] of [
    ["subnetCIDRs", subnetCIDRs],
    ["shortNames", shortNames],
    ["dnsRoutes", dnsRoutes],
  ] as const) {
    if (
      !Array.isArray(raw[key]) ||
      (raw[key] as unknown[]).length > 8192 ||
      clean.length !== new Set(raw[key] as unknown[]).size
    )
      return null;
  }
  if (
    typeof raw.magicDNSSuffix !== "string" ||
    sanitizeMagicDNSSuffix(raw.magicDNSSuffix) !== raw.magicDNSSuffix
  )
    return null;
  const split = normalizeDomainSplit(raw.domainSplit);
  if (JSON.stringify(split) !== JSON.stringify(raw.domainSplit)) return null;
  return {
    scope: raw.scope,
    selectedExitNodeID: raw.selectedExitNodeID as string | null,
    magicDNSSuffix: sanitizeMagicDNSSuffix(
      typeof raw.magicDNSSuffix === "string" ? raw.magicDNSSuffix : "",
    ),
    subnetCIDRs,
    shortNames,
    dnsRoutes,
    domainSplit: split,
  };
}
function emptyPolicy(): RoutingPolicy {
  return {
    mode: "direct",
    proxyPort: null,
    selectedExitNodeID: null,
    magicDNSSuffix: "",
    subnetCIDRs: [],
    shortNames: [],
    dnsRoutes: [],
    domainSplit: { mode: "bypass", domains: [] },
  };
}
export function policyFromState(state: TailscaleState): RoutingPolicy {
  if (state.routingPolicy) return state.routingPolicy;
  const selectedExitNodeID =
    state.pendingExitNodeID ||
    state.prefs?.exitNodeID ||
    state.exitNode?.id ||
    null;
  return {
    ...emptyPolicy(),
    mode: shouldProxyState(state)
      ? selectedExitNodeID &&
        (!state.exitNode?.online || state.exitNode.id !== selectedExitNodeID)
        ? "blocked"
        : "active"
      : "direct",
    proxyPort: state.proxyPort,
    selectedExitNodeID,
    magicDNSSuffix: sanitizeMagicDNSSuffix(state.magicDNSSuffix),
    subnetCIDRs: collectSubnetCIDRs(state.peers).filter(
      (s) => parseCIDR(s) !== null,
    ),
    domainSplit: normalizeDomainSplit(state.domainSplit),
  };
}

export class RoutingProtection {
  private active: Snapshot | null = null;
  private profiles = new Map<string, Snapshot>();
  private ready = false;
  private uncertain = false;
  private released = false;
  private transitioning = false;
  private pendingExit: string | null = null;
  private pendingDisconnect = false;
  private writeChain = Promise.resolve();
  private savedKey = "";
  private revision = 0;

  async restore(): Promise<void> {
    const revision = this.revision;
    try {
      const result = await chrome.storage.local.get(ROUTING_STORAGE_KEY);
      if (revision !== this.revision) {
        this.ready = true;
        return;
      }
      const saved = result[ROUTING_STORAGE_KEY] as SavedRouting | undefined;
      if (saved) {
        this.released = saved.released === true;
        this.transitioning = saved.transitioning === true;
        this.active = snapshot(saved.active);
        if (this.active) {
          this.pendingExit =
            typeof saved.pendingExit === "string" &&
            saved.pendingExit.length <= 256
              ? saved.pendingExit
              : null;
          this.pendingDisconnect = saved.pendingDisconnect === true;
        }
        this.uncertain = saved.active !== null && !this.active;
        if (Array.isArray(saved.profiles)) {
          for (const raw of saved.profiles.slice(-32)) {
            const value = snapshot(raw);
            if (value) this.profiles.set(value.scope, value);
          }
        }
      }
    } catch {
      if (revision === this.revision) this.uncertain = true;
    }
    this.ready = true;
  }

  selectExitNode(id: string): void {
    this.revision += 1;
    this.pendingExit = id;
    this.released = false;
    if (id && this.active) {
      this.active = { ...this.active, selectedExitNodeID: id };
    }
    this.save();
  }
  requestDisconnect(): void {
    this.pendingDisconnect = true;
    this.save();
  }
  reconnect(): void {
    this.released = false;
  }
  switchProfile(): void {
    this.released = false;
    this.pendingExit = null;
    this.pendingDisconnect = false;
    this.transitioning = true;
    this.save();
  }
  release(): void {
    this.revision += 1;
    this.transitioning = false;
    this.uncertain = false;
    this.pendingExit = null;
    this.pendingDisconnect = false;
    this.released = true;
    this.save();
  }

  confirmStatus(status: StatusUpdate, state: TailscaleState): void {
    const incomingScope =
      status.selfNode?.id && status.prefs
        ? JSON.stringify([status.prefs.controlURL || "", status.selfNode.id])
        : null;
    if (
      incomingScope &&
      (!this.active || incomingScope !== this.active.scope)
    ) {
      this.transitioning = false;
      this.pendingExit = null;
      this.pendingDisconnect = false;
    }
    if (
      this.pendingDisconnect &&
      (status.backendState === "Stopped" || status.backendState === "NeedsLogin")
    ) {
      this.release();
      return;
    }
    if (this.released || !status.selfNode?.id || !status.prefs) return;
    const scope = JSON.stringify([
      status.prefs.controlURL || "",
      status.selfNode.id,
    ]);
    const prior =
      this.active?.scope === scope ? this.active : this.profiles.get(scope);
    const confirmed = status.prefs.exitNodeID || status.exitNode?.id || null;
    let selected =
      this.pendingExit || confirmed || prior?.selectedExitNodeID || null;
    if (this.pendingExit === "" && !confirmed) selected = null;
    if (this.pendingExit !== null && (this.pendingExit || null) === confirmed)
      this.pendingExit = null;
    if (!prior && !selected && status.backendState !== "Running") return;
    const policy = policyFromState({
      ...state,
      ...status,
      routingPolicy: undefined,
      pendingExitNodeID: null,
    });
    this.active = {
      scope,
      selectedExitNodeID: selected,
      magicDNSSuffix: policy.magicDNSSuffix || prior?.magicDNSSuffix || "",
      subnetCIDRs: [
        ...new Set([...(prior?.subnetCIDRs ?? []), ...policy.subnetCIDRs]),
      ],
      shortNames: [
        ...new Set([...(prior?.shortNames ?? []), ...policy.shortNames]),
      ],
      dnsRoutes: [
        ...new Set([...(prior?.dnsRoutes ?? []), ...policy.dnsRoutes]),
      ],
      domainSplit: policy.domainSplit,
    };
    this.save();
  }

  decorate(state: TailscaleState): TailscaleState {
    let policy = policyFromState(state);
    if (!this.ready || this.uncertain || this.transitioning) {
      policy = { ...emptyPolicy(), mode: "blocked", blockAll: true };
    } else if (this.released) {
      policy = emptyPolicy();
    } else if (this.active) {
      const domainSplit = normalizeDomainSplit(state.domainSplit);
      if (
        JSON.stringify(domainSplit) !== JSON.stringify(this.active.domainSplit)
      ) {
        this.active = { ...this.active, domainSplit };
        this.save();
      }
      const scope =
        state.selfNode?.id && state.prefs
          ? JSON.stringify([state.prefs.controlURL || "", state.selfNode.id])
          : null;
      const selected = this.active.selectedExitNodeID;
      const live =
        shouldProxyState(state) &&
        scope === this.active.scope &&
        (!selected ||
          (state.exitNode?.id === selected && state.exitNode.online));
      policy = {
        ...this.active,
        domainSplit: normalizeDomainSplit(state.domainSplit),
        mode: live ? "active" : "blocked",
        proxyPort: live ? state.proxyPort : null,
      };
    } else if (!shouldProxyState(state)) {
      policy = emptyPolicy();
    }
    return {
      ...state,
      routingPolicy: policy,
      selectedExitNodeID: policy.selectedExitNodeID,
    };
  }

  private save(): void {
    if (this.active) this.profiles.set(this.active.scope, this.active);
    const value: SavedRouting = {
      active: this.active,
      released: this.released,
      transitioning: this.transitioning,
      pendingExit: this.pendingExit,
      pendingDisconnect: this.pendingDisconnect,
      profiles: [...this.profiles.values()].slice(-32),
    };
    const key = JSON.stringify(value);
    if (key === this.savedKey) return;
    this.savedKey = key;
    this.writeChain = this.writeChain
      .then(() => chrome.storage.local.set({ [ROUTING_STORAGE_KEY]: value }))
      .catch(() => {
        this.savedKey = "";
      });
  }
}
