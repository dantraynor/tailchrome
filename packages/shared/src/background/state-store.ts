import type { TailscaleState, StatusUpdate, PeerInfo } from "../types";

export type StateListener = (state: TailscaleState) => void;

const DEFAULT_STATE: TailscaleState = {
  stateVersion: 0,
  hostConnected: false,
  initialized: false,
  proxyPort: null,
  proxyEnabled: false,
  backendState: "NoState",
  tailnet: null,
  selfNode: null,
  peers: [],
  exitNode: null,
  magicDNSSuffix: null,
  browseToURL: null,
  prefs: null,
  health: [],
  pendingExitNodeID: null,
  currentProfile: null,
  profiles: [],
  exitNodeSuggestion: null,
  domainSplit: { mode: "bypass", domains: [] },
  error: null,
  installError: false,
  hostVersion: null,
  hostVersionMismatch: false,
  supportsNetcheck: false,
  supportsPingPeer: false,
  supportsLogin: false,
  reconnecting: false,
};

export class StateStore {
  private state: TailscaleState;
  private listeners: Set<StateListener> = new Set();

  constructor() {
    this.state = { ...DEFAULT_STATE };
  }

  getState(): TailscaleState {
    return this.state;
  }

  update(partial: Partial<TailscaleState>): void {
    this.state = { ...this.state, ...partial, stateVersion: this.state.stateVersion + 1 };
    this.notifyListeners();
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  applyStatusUpdate(status: StatusUpdate): void {
    const confirmedExitNodeID =
      status.exitNode?.id ?? status.prefs?.exitNodeID ?? null;
    const pendingExitNodeID = nextPendingExitNodeID(
      this.state.pendingExitNodeID,
      confirmedExitNodeID,
    );

    this.update({
      backendState: status.backendState,
      tailnet: status.tailnet,
      selfNode: status.selfNode
        ? { ...status.selfNode, tailscaleIPs: status.selfNode.tailscaleIPs ?? [] }
        : null,
      peers: (status.peers ?? []).map((p: PeerInfo) => ({
        ...p,
        tailscaleIPs: p.tailscaleIPs ?? [],
        subnets: p.subnets ?? [],
        tags: p.tags ?? [],
      })),
      exitNode: status.exitNode ?? null,
      magicDNSSuffix: status.magicDNSSuffix,
      browseToURL: status.browseToURL || status.authURL || null,
      prefs: status.prefs,
      health: status.health ?? [],
      error: status.error,
      pendingExitNodeID,
    });
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (err) {
        console.error("[StateStore] Listener threw:", err);
      }
    }
  }
}

function nextPendingExitNodeID(
  pendingExitNodeID: string | null,
  confirmedExitNodeID: string | null,
): string | null {
  if (pendingExitNodeID === null) return null;
  if ((pendingExitNodeID || null) === (confirmedExitNodeID || null)) {
    return null;
  }

  return pendingExitNodeID;
}
