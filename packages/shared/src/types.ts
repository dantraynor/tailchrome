// Backend states from IPN
export type BackendState =
  | "NoState"
  | "NeedsMachineAuth"
  | "NeedsLogin"
  | "InUseOtherUser"
  | "Stopped"
  | "Starting"
  | "Running";

// === Native Messaging Protocol ===

export type NativeRequest =
  | { cmd: "init"; initID: string }
  | { cmd: "up" }
  | { cmd: "down" }
  | { cmd: "get-status" }
  | { cmd: "ping" }
  | { cmd: "set-exit-node"; nodeID: string }
  | { cmd: "set-prefs"; prefs: Partial<TailscalePrefs> }
  | { cmd: "list-profiles" }
  | { cmd: "switch-profile"; profileID: string }
  | { cmd: "new-profile" }
  | { cmd: "delete-profile"; profileID: string }
  | {
      cmd: "send-file";
      nodeID: string;
      fileName: string;
      fileData: string;
      fileSize: number;
      transferID?: string;
      chunkIndex?: number;
      chunkCount?: number;
    }
  | { cmd: "suggest-exit-node" }
  | { cmd: "logout" }
  | { cmd: "ping-peer"; nodeID: string }
  | { cmd: "bug-report"; note?: string }
  | { cmd: "netcheck" };

export interface NativeReply {
  procRunning?: {
    port: number;
    pid: number;
    version?: string;
    error?: string;
    /** When true, the native host handles the `netcheck` command (omitted on older helpers). */
    supportsNetcheck?: boolean;
    /** When true, the native host handles `ping-peer` (omitted on older helpers). */
    supportsPingPeer?: boolean;
  };
  init?: { error?: string };
  pong?: Record<string, never>;
  status?: StatusUpdate;
  profiles?: ProfilesResult;
  exitNodeSuggestion?: ExitNodeSuggestion;
  fileSendProgress?: FileSendProgress;
  diagnostic?: { title: string; body: string };
  error?: { cmd: string; message: string };
}

// === Status from native host ===

export interface StatusUpdate {
  backendState: BackendState;
  running: boolean;
  tailnet: string | null;
  magicDNSSuffix: string;
  selfNode: SelfNode | null;
  needsLogin: boolean;
  browseToURL: string;
  exitNode: ExitNodeInfo | null;
  peers: PeerInfo[];
  prefs: TailscalePrefs | null;
  health: string[];
  error: string | null;
}

export interface SelfNode {
  id: string;
  hostname: string;
  dnsName: string;
  tailscaleIPs: string[];
  os: string;
  online: boolean;
  keyExpiry: string | null;
}

export interface PeerInfo {
  id: string;
  hostname: string;
  dnsName: string;
  tailscaleIPs: string[];
  os: string;
  online: boolean;
  active: boolean;
  exitNode: boolean;
  exitNodeOption: boolean;
  isSubnetRouter: boolean;
  subnets: string[];
  tags: string[];
  rxBytes: number;
  txBytes: number;
  lastSeen: string | null;
  lastHandshake: string | null;
  /** Present for self and peers when the control plane reports key expiry. */
  keyExpiry?: string | null;
  location: PeerLocation | null;
  taildropTarget: boolean;
  sshHost: boolean;
  userId: number;
  userName: string;
  userLoginName: string;
  userProfilePicURL: string;
}

export interface PeerLocation {
  city: string;
  cityCode: string;
  country: string;
  countryCode: string;
}

export interface ExitNodeInfo {
  id: string;
  hostname: string;
  location: PeerLocation | null;
  online: boolean;
}

export interface ExitNodeSuggestion {
  id: string;
  hostname: string;
  location: PeerLocation | null;
}

export interface TailscalePrefs {
  exitNodeID: string;
  exitNodeAllowLANAccess: boolean;
  corpDNS: boolean;
  shieldsUp: boolean;
  advertiseExitNode: boolean;
  /** When omitted, treat as false (older hosts). */
  runSSH?: boolean;
  advertiseRoutes?: string[];
}

export interface ProfileInfo {
  id: string;
  name: string;
}

export interface ProfilesResult {
  current: ProfileInfo;
  profiles: ProfileInfo[];
}

export interface SendFileRequest {
  targetNodeID: string;
  name: string;
  size: number;
  dataBase64: string;
}

export interface FileSendProgress {
  targetNodeID: string;
  name: string;
  percent: number;
  done: boolean;
  error: string | null;
}

// === Extension internal state ===

export interface TailscaleState {
  /** Monotonically increasing counter, incremented on every state update. */
  stateVersion: number;
  hostConnected: boolean;
  initialized: boolean;
  proxyPort: number | null;
  proxyEnabled: boolean;

  backendState: BackendState;
  tailnet: string | null;
  selfNode: SelfNode | null;
  peers: PeerInfo[];
  exitNode: ExitNodeInfo | null;
  magicDNSSuffix: string | null;
  browseToURL: string | null;
  prefs: TailscalePrefs | null;
  health: string[];

  currentProfile: ProfileInfo | null;
  profiles: ProfileInfo[];

  exitNodeSuggestion: ExitNodeSuggestion | null;

  error: string | null;
  installError: boolean;
  hostVersion: string | null;
  hostVersionMismatch: boolean;
  /** True when the connected native helper advertises `supportsNetcheck` in procRunning. */
  supportsNetcheck: boolean;
  /** True when the connected native helper advertises `supportsPingPeer` in procRunning. */
  supportsPingPeer: boolean;
  /** True when the native host disconnected and reconnection is being attempted. */
  reconnecting: boolean;
}

// Messages from background to popup
export type PopupMessage =
  | { type: "state"; state: TailscaleState }
  | {
      type: "toast";
      message: string;
      level: "info" | "error";
      persistent?: boolean;
      /** Auto-dismiss delay when not persistent (ms). */
      dismissMs?: number;
      /** Preserve newlines (e.g. diagnostics toast). */
      multiline?: boolean;
    };

type ScalarPrefKey = Exclude<keyof TailscalePrefs, "advertiseRoutes">;
type SetPrefMessage = {
  [K in ScalarPrefKey]-?: {
    type: "set-pref";
    key: K;
    value: Exclude<TailscalePrefs[K], undefined>;
  };
}[ScalarPrefKey];

// Messages from popup to background
export type BackgroundMessage =
  | { type: "toggle" }
  | { type: "login" }
  | { type: "logout" }
  | { type: "set-exit-node"; nodeID: string }
  | { type: "clear-exit-node" }
  | SetPrefMessage
  | { type: "set-advertise-routes"; routes: string[] }
  | { type: "ping-peer"; nodeID: string }
  | { type: "bug-report"; note?: string }
  | { type: "netcheck" }
  | { type: "switch-profile"; profileID: string }
  | { type: "new-profile" }
  | { type: "delete-profile"; profileID: string }
  | {
      type: "send-file";
      targetNodeID: string;
      name: string;
      size: number;
      dataBase64: string;
      transferID?: string;
      chunkIndex?: number;
      chunkCount?: number;
    }
  | { type: "suggest-exit-node" }
  | { type: "open-admin" }
  | { type: "open-web-client" };

// === Proxy manager interface ===

export interface ProxyManager {
  apply(state: TailscaleState): void;
  clear(): void;
}
