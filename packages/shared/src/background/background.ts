import type {
  NativeReply,
  TailscaleState,
  BackgroundMessage,
  PopupMessage,
  ProxyManager,
  HelperDiagnostic,
  HelperFailure,
  HelperVersionNotice,
} from "../types";
import {
  KEEPALIVE_INTERVAL_MS,
  ADMIN_URL,
  TAILSCALE_SERVICE_IP,
  DEFAULT_LOGIN_ORIGINS,
  isCustomControlURL,
  isValidControlURL,
} from "../constants";
import { StateStore } from "./state-store";
import {
  NativeHostConnection,
  type NativeConnectionEvent,
} from "./native-host";
import { sanitizeDiagnosticMessage } from "../helper-diagnostics";
import { BadgeManager } from "./badge-manager";
import { DefaultTimerService, type TimerService } from "./timer-service";
import { applyUiSurface, readUiSurface, type BrowserKind } from "./ui-surface";
import {
  clearPersistedIntent,
  clearSessionIntent,
  isAutoConnectHandled,
  markAutoConnectHandled,
  readAutoConnectPref,
  readPersistedIntent,
  readSessionIntent,
  shouldAutoConnect,
  writeAutoConnectPref,
  writePersistedIntent,
  writeSessionIntent,
} from "./auto-connect";
import {
  DOMAIN_SPLIT_STORAGE_KEY,
  normalizeDomainSplit,
  readDomainSplit,
  writeDomainSplit,
} from "./domain-split";

export type { ProxyManager };

export interface BackgroundHandle {
  proxyManager: ProxyManager;
  /** Send a keepalive ping if the host is connected. */
  sendKeepalive(): void;
  /** Reconnect to the native host. */
  reconnect(): Promise<void>;
  /** Restore a pending helper-discovery retry after an MV3 worker wake. */
  rehydrateHelperRetries(): Promise<void>;
}

export interface InitBackgroundOptions {
  /** Custom timer implementation (e.g. for reconnect backoff). Defaults to setTimeout/setInterval. */
  timerService?: TimerService;
  /** Skip the built-in setInterval keepalive (e.g. when the caller uses browser.alarms instead). */
  skipKeepalive?: boolean;
  browserKind?: BrowserKind;
  /** Lifecycle events captured synchronously by a caller that must await before initializing. */
  initialRuntimeLifecycle?: {
    browserStartup?: boolean;
    installedReason?: chrome.runtime.InstalledDetails["reason"];
  };
}

const LOGIN_OPEN_TIMEOUT_MS = 30_000;
const LOGIN_OPEN_TIMEOUT_NAME = "login-open-timeout";

// How long the update corrector waits for onStartup before trusting that an
// onInstalled("update") happened mid-session. Both events of one service-worker
// start dispatch back-to-back right after evaluation, so a short settle is
// enough to observe them together when the update applied at browser launch.
const UPDATE_RESTORE_SETTLE_MS = 250;
const RUNTIME_LIFECYCLE_SETTLE_TIMER_NAME = "runtime-lifecycle-settle";

/**
 * Returns true if `url` is a login URL we'll open in a tab. Always accepts the
 * Tailscale-managed origins when using the default coordination server. For
 * custom coordination servers, allow delegated HTTPS auth URLs while rejecting
 * stale Tailscale-managed login URLs from a previous default-server status.
 */
export function isValidLoginURL(url: string, controlURL?: string | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (isCustomControlURL(controlURL)) {
    if (DEFAULT_LOGIN_ORIGINS.includes(parsed.origin)) return false;
    if (parsed.protocol === "https:") return true;
    try {
      const controlProtocol = new URL(controlURL!).protocol;
      return controlProtocol === "http:" && parsed.protocol === "http:";
    } catch {
      return false;
    }
  }
  if (DEFAULT_LOGIN_ORIGINS.includes(parsed.origin)) return true;
  return false;
}

/**
 * True only for a login URL served from a Tailscale-default origin — the
 * stale-linger case worth waiting out after switching to a custom server. A
 * malformed or custom-origin-but-invalid URL is NOT stale; it should surface an
 * error rather than spin until the pending-login timeout.
 */
function isDefaultOriginLoginURL(url: string): boolean {
  try {
    return DEFAULT_LOGIN_ORIGINS.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

function loginURLFromStatus(status: NativeReply["status"]): string | null {
  if (!status) return null;
  return status.browseToURL || status.authURL || null;
}

/**
 * Coarse, origin-level check for whether saving `next` actually changes the
 * coordination server vs the currently-cached `current`. Used only to decide
 * when to drop switch-scoped cached state; the native host stays the authority
 * on the real change. All default-server synonyms collapse to the same key.
 */
function controlServerChanged(
  next: string,
  current: string | undefined | null,
): boolean {
  const key = (url: string | undefined | null): string => {
    if (!url || !isCustomControlURL(url)) return "";
    try {
      // Mirror the host's `controlURLCompareKey`: lowercase scheme+host but
      // keep the (case-sensitive) path and query, so a same-origin switch that
      // only changes the path still counts as a real server change. Drop a bare
      // "/" path and the fragment, matching the host's normalization.
      const u = new URL(url);
      u.hash = "";
      if (u.pathname === "/" && u.search === "") u.pathname = "";
      return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname}${u.search}`;
    } catch {
      return url.trim().toLowerCase();
    }
  };
  return key(next) !== key(current);
}

export function getHelperVersionNotice(
  installedVersion: string | null,
  releaseVersion: string,
): HelperVersionNotice | null {
  const installed = parseReleaseVersion(installedVersion);
  const release = parseReleaseVersion(releaseVersion);
  if (!installed || !release) return null;
  if (installed.normalized === release.normalized) return null;

  for (let i = 0; i < installed.numbers.length; i++) {
    const installedPart = installed.numbers[i]!;
    const releasePart = release.numbers[i]!;
    if (installedPart < releasePart) {
      return { installedVersion: installed.raw, releaseVersion: release.raw, relation: "older" };
    }
    if (installedPart > releasePart) {
      return { installedVersion: installed.raw, releaseVersion: release.raw, relation: "newer" };
    }
  }

  return {
    installedVersion: installed.raw,
    releaseVersion: release.raw,
    relation: "different",
  };
}

function parseReleaseVersion(value: string | null): {
  raw: string;
  normalized: string;
  numbers: [number, number, number];
} | null {
  if (!value) return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?$/.exec(
    value,
  );
  if (!match) return null;
  const numbers = [Number(match[1]), Number(match[2]), Number(match[3])] as [
    number,
    number,
    number,
  ];
  if (numbers.some((part) => !Number.isSafeInteger(part))) return null;
  return {
    raw: value.replace(/^v/, ""),
    normalized: value.replace(/^v/, ""),
    numbers,
  };
}

function normalizedHelperVersion(value: string | undefined): string | null {
  return parseReleaseVersion(value ?? null)?.raw ?? null;
}

function extensionReleaseVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return "unknown";
  }
}

const NATIVE_HOST_UNREACHABLE =
  "Could not reach Tailscale service. Please check that the native host is installed.";

function nativeCommandErrorCopy(command: string): string {
  switch (command) {
    case "login":
      return "The helper could not start login. Please try again.";
    case "up":
    case "down":
      return "The helper could not change the connection state.";
    case "set-exit-node":
      return "The helper could not change the exit node.";
    case "set-prefs":
      return "The helper could not save that setting.";
    case "send-file":
      return "The helper could not send the file.";
    case "switch-profile":
    case "new-profile":
    case "delete-profile":
      return "The helper could not update the selected profile.";
    case "ping-peer":
    case "netcheck":
      return "The helper could not run that diagnostic.";
    default:
      return "The helper could not complete that request.";
  }
}

/** Poll schedule for native-host discovery after the user starts an installer. */
const INSTALL_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
const INSTALL_RETRY_SETTLE_MS = 2_000;
const HELPER_RETRY_TIMER_NAME = "helper-activation-retry";
const HELPER_RETRY_STORAGE_KEY = "helperActivationRetry";
const HELPER_REPAIR_STORAGE_KEY = "helperRegistrationRepairAvailable";

type HelperRetrySource = "package" | "fallback" | "manual";

interface HelperRetryRecord {
  source: HelperRetrySource;
  nextRetryIndex: number;
  nextRetryAt: number;
}

function isHelperRetryRecord(value: unknown): value is HelperRetryRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<HelperRetryRecord>;
  return (
    (record.source === "package" ||
      record.source === "fallback" ||
      record.source === "manual") &&
    Number.isInteger(record.nextRetryIndex) &&
    (record.nextRetryIndex ?? -1) >= 0 &&
    typeof record.nextRetryAt === "number" &&
    Number.isFinite(record.nextRetryAt)
  );
}

function domainSplitEquals(
  a: { mode: string; domains: string[] },
  b: { mode: string; domains: string[] },
): boolean {
  if (a.mode !== b.mode) return false;
  if (a.domains.length !== b.domains.length) return false;
  for (let i = 0; i < a.domains.length; i++) {
    if (a.domains[i] !== b.domains[i]) return false;
  }
  return true;
}

export function initBackground(
  proxyManager: ProxyManager,
  nativeHostId: string,
  options?: InitBackgroundOptions,
): BackgroundHandle {
  const timerService: TimerService =
    options?.timerService ?? new DefaultTimerService();
  const browserKind: BrowserKind = options?.browserKind ?? "chrome";
  const releaseVersion = extensionReleaseVersion();

  // Apply the persisted UI-surface preference and react to changes.
  // Catch rejections so the service worker startup never fails on a
  // missing-API edge case (older Chrome, Firefox without the polyfill, etc.).
  const logUiSurfaceFailure = (err: unknown): void => {
    console.warn("[Background] applyUiSurface failed:", err);
  };
  void readUiSurface()
    .then((surface) => applyUiSurface(surface, browserKind))
    .catch(logUiSurfaceFailure);

  const store = new StateStore();

  void readDomainSplit()
    .then((config) => {
      if (!domainSplitEquals(store.getState().domainSplit, config)) {
        store.update({ domainSplit: config });
      }
    })
    .catch((err) => {
      console.warn("[Background] readDomainSplit failed:", err);
    });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("uiSurface" in changes) {
      const next = changes["uiSurface"]?.newValue;
      if (next === "popup" || next === "sidePanel") {
        void applyUiSurface(next, browserKind).catch(logUiSurfaceFailure);
      }
    }
    if (DOMAIN_SPLIT_STORAGE_KEY in changes) {
      const next = normalizeDomainSplit(
        changes[DOMAIN_SPLIT_STORAGE_KEY]?.newValue,
      );
      const current = store.getState().domainSplit;
      if (!domainSplitEquals(current, next)) {
        store.update({ domainSplit: next });
      }
    }
  });
  const badgeManager = new BadgeManager();

  // Connected popup ports
  const popupPorts: Set<chrome.runtime.Port> = new Set();
  // Newest connection decision this background lifetime knows about. Updated
  // synchronously at every point the decision changes (user toggle, login,
  // auto-connect, startup hint resolution), so the auto-disconnect fallback
  // can never act on a storage read that lags behind a click the user just
  // made — the mirror always wins over storage.
  let sessionIntentMirror: boolean | undefined;
  // Serialize storage writes and read the mirror only when each queued write
  // begins. Rapid toggles and an in-flight startup resolution therefore
  // converge on the newest decision instead of allowing a slower old write
  // to become the value a later service-worker lifetime restores.
  let intentWriteChain: Promise<void> = Promise.resolve();
  // One corrective `down` per native-host connection. A fresh host process
  // re-applies tsnet's forced auto-up at init, so the latch resets when the
  // host disconnects (see handleNativeConnectionEvent) and the next connection
  // gets its own corrective window.
  let autoDisconnectAttempted = false;
  // True once the mirror holds a deliberate decision (user action, login,
  // auto-connect, profile switch) rather than the pref-derived startup
  // resolution. Late lifecycle events must never override a deliberate choice.
  let intentExplicitlyDecided = false;
  // What the startup resolution decided when it had to guess without a
  // conclusive lifecycle signal. Event delivery has no deadline, so the
  // settle window is only a fast path: an onStartup/onInstalled arriving
  // after it re-runs the part of this decision it would have changed.
  let startupResolution: {
    pref: boolean;
    persisted: boolean | undefined;
    usedRecovery: boolean;
  } | null = null;

  // Register runtime lifecycle listeners before the first asynchronous host
  // initialization step. An update clears storage.session, so the native init
  // hint must wait briefly for these signals when a persisted intent exists;
  // restoring only after connecting would transiently apply the opposite
  // decision. Firefox forwards events captured before its proxy restore.
  let sawBrowserStartup =
    options?.initialRuntimeLifecycle?.browserStartup === true;
  let sawExtensionUpdate =
    options?.initialRuntimeLifecycle?.installedReason === "update";
  let startupClearPromise: Promise<void> = Promise.resolve();
  const handleBrowserStartup = (): void => {
    sawBrowserStartup = true;
    intentWriteChain = intentWriteChain.then(async () => {
      try {
        await clearPersistedIntent();
      } catch (err) {
        console.warn("[Background] clearPersistedIntent failed:", err);
      }
    });
    startupClearPromise = intentWriteChain;
    // Arriving after the settle window means this was a browser launch after
    // all: if the resolution restored the persisted intent in the meantime,
    // that restore was wrong — a fresh session follows the preference alone.
    // Re-decide, unless the user has made a deliberate choice since.
    if (
      startupResolution?.usedRecovery &&
      !intentExplicitlyDecided &&
      sessionIntentMirror !== startupResolution.pref
    ) {
      sessionIntentMirror = startupResolution.pref;
      void enqueueIntentWrite(false);
      if (latestBackendState !== null) {
        maybeAutoDisconnect(latestBackendState);
      }
    }
  };
  const handleInstalled = (
    reason: chrome.runtime.InstalledDetails["reason"],
  ): void => {
    chrome.contextMenus.create({
      id: "tailscale-send-page",
      title: "Send page URL to Tailscale device",
      contexts: ["page"],
    });
    if (reason !== "update") return;
    sawExtensionUpdate = true;
    // Arriving after the settle window means the resolution already fell
    // back to the preference, and the host may have forced the node down
    // against a persisted run intent — the wipe this recovery exists for.
    // Restore it now, unless a browser startup was observed (fresh session,
    // preference governs) or the user has made a deliberate choice since.
    if (
      startupResolution !== null &&
      !startupResolution.usedRecovery &&
      startupResolution.persisted === true &&
      !sawBrowserStartup &&
      !intentExplicitlyDecided
    ) {
      // This restore is still the lifecycle guess, not a user decision: mark
      // the resolution as recovery-based (so an even later onStartup can
      // re-derive to the preference) and leave intentExplicitlyDecided unset
      // — recordIntent would freeze the guess as if the user had chosen.
      startupResolution.usedRecovery = true;
      sessionIntentMirror = true;
      void enqueueIntentWrite(true);
      if (
        latestBackendState === null ||
        shouldAutoConnect(latestBackendState)
      ) {
        // No status yet means the host is still initializing and the `up`
        // lands right after its init. User-driven states like NeedsLogin
        // keep their own flows; the recorded intent covers later respawns.
        nativeHost.send({ cmd: "up" });
      }
    }
  };
  chrome.runtime.onStartup?.addListener(handleBrowserStartup);
  chrome.runtime.onInstalled?.addListener((details) => {
    handleInstalled(details.reason);
  });
  if (sawBrowserStartup) handleBrowserStartup();
  if (options?.initialRuntimeLifecycle?.installedReason) {
    handleInstalled(options.initialRuntimeLifecycle.installedReason);
  }
  const initialLifecycleCaptured =
    sawBrowserStartup ||
    (options?.initialRuntimeLifecycle?.installedReason != null &&
      options.initialRuntimeLifecycle.installedReason !== "update");
  const runtimeLifecycleSettled = initialLifecycleCaptured
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        timerService.setTimeout(
          RUNTIME_LIFECYCLE_SETTLE_TIMER_NAME,
          resolve,
          UPDATE_RESTORE_SETTLE_MS,
        );
      });

  // Track whether we've attempted to restore exit node for this connection
  let exitNodeRestoreAttempted = false;
  let latestBackendState: TailscaleState["backendState"] | null = null;
  let sawHealthyProcRunning = false;
  let sawHealthyInit = false;
  let helperRetryRecord: HelperRetryRecord | null = null;
  // Last coordination server the host has actually confirmed. Used to drop
  // switch-scoped persistent state (the saved exit node) only once the server
  // change is committed — never optimistically, since the host can roll a
  // switch back. `undefined` means no status has established a baseline yet.
  let lastConfirmedControlURL: string | undefined;

  // Hydrate the auto-connect preference so the popup reflects it on first
  // render. If the first native status arrived before storage resolved, re-run
  // the auto-connect decision against that real status rather than the default.
  void readAutoConnectPref()
    .then((value) => {
      store.update({ autoConnectOnStart: value });
      if (value && latestBackendState !== null) {
        maybeAutoConnect(latestBackendState);
      }
    })
    .catch((err) => {
      console.warn("[Background] readAutoConnectPref failed:", err);
    });
  let pendingLoginOpen = false;

  function clearPendingLoginOpen(): void {
    pendingLoginOpen = false;
    timerService.clear(LOGIN_OPEN_TIMEOUT_NAME);
  }

  function startPendingLoginOpen(): void {
    pendingLoginOpen = true;
    timerService.setTimeout(
      LOGIN_OPEN_TIMEOUT_NAME,
      () => {
        if (!pendingLoginOpen) return;
        pendingLoginOpen = false;
        sendToastToPopup(
          "Still waiting for a Tailscale login URL. Please try again.",
          "error",
        );
      },
      LOGIN_OPEN_TIMEOUT_MS,
    );
  }

  store.subscribe((state: TailscaleState) => {
    proxyManager.apply(state);
    badgeManager.update(state);
    broadcastToPopup(state);
  });

  function diagnosticFrom(
    diagnosticCode: string,
    detail: unknown,
  ): HelperDiagnostic {
    return {
      diagnosticCode,
      diagnosticMessage: sanitizeDiagnosticMessage(detail),
    };
  }

  function setHelperReportedFailure(
    diagnosticCode: string,
    detail: unknown,
  ): void {
    const diagnostic = diagnosticFrom(diagnosticCode, detail);
    const failure: HelperFailure = {
      kind: "helper-reported-error",
      ...diagnostic,
    };
    store.update({
      helperFailure: failure,
      helperDiagnostic: diagnostic,
      reconnecting: false,
    });
  }

  function clearHelperRetryStorage(): Promise<void> {
    helperRetryRecord = null;
    timerService.clear(HELPER_RETRY_TIMER_NAME);
    return Promise.all([
      chrome.storage.session.remove(HELPER_RETRY_STORAGE_KEY),
      chrome.storage.session.remove(HELPER_REPAIR_STORAGE_KEY),
    ]).then(() => undefined);
  }

  function maybeCompleteHelperRecovery(): void {
    if (!sawHealthyProcRunning || !sawHealthyInit) return;
    store.update({
      helperFailure: null,
      helperDiagnostic: null,
      repairRegistrationAvailable: false,
      reconnecting: false,
    });
    void clearHelperRetryStorage().catch((err) => {
      console.warn(
        `[Background] Could not clear helper retry session state: ${sanitizeDiagnosticMessage(err) ?? "unknown"}`,
      );
    });
  }

  function handleNativeMessage(msg: NativeReply): void {
    // Process running: the native host tells us which port to proxy through
    if (msg.procRunning) {
      const hostVersion = normalizedHelperVersion(msg.procRunning.version);
      const helperVersionNotice = getHelperVersionNotice(
        hostVersion,
        releaseVersion,
      );
      if (msg.procRunning.version && !hostVersion) {
        store.update({
          helperDiagnostic: diagnosticFrom(
            "helper-version-unparseable",
            msg.procRunning.version,
          ),
        });
      }

      if (msg.procRunning.error) {
        sawHealthyProcRunning = false;
        setHelperReportedFailure(
          "helper-proc-running-error",
          msg.procRunning.error,
        );
        store.update({
          hostVersion,
          helperVersionNotice,
          proxyPort: null,
          proxyEnabled: false,
          supportsNetcheck: false,
          supportsPingPeer: false,
          supportsLogin: false,
          supportsCustomControlURL: false,
        });
      } else {
        sawHealthyProcRunning = true;
        store.update({
          proxyPort: msg.procRunning.port,
          proxyEnabled: true,
          hostVersion,
          helperVersionNotice,
          supportsNetcheck: msg.procRunning.supportsNetcheck === true,
          supportsPingPeer: msg.procRunning.supportsPingPeer === true,
          supportsLogin: msg.procRunning.supportsLogin === true,
          supportsCustomControlURL: msg.procRunning.supportsCustomControlURL === true,
        });
        maybeCompleteHelperRecovery();
      }
    }

    // Init acknowledgement
    if (msg.init) {
      if (msg.init.error) {
        sawHealthyInit = false;
        setHelperReportedFailure("helper-init-error", msg.init.error);
        store.update({ initialized: false });
      } else {
        sawHealthyInit = true;
        store.update({ initialized: true });
        maybeCompleteHelperRecovery();
        // Request initial status and profile list
        nativeHost.send({ cmd: "get-status" });
        nativeHost.send({ cmd: "list-profiles" });
      }
    }

    // Pong: no-op, just keeps service worker alive
    if (msg.pong) {
      // Keepalive acknowledged
    }

    // Status update
    if (msg.status) {
      latestBackendState = msg.status.backendState;
      store.applyStatusUpdate(msg.status);

      // Drop the saved exit node once the host confirms a real coordination
      // server change (a node from the old tailnet won't exist on the new one).
      // Reacting to the confirmed prefs — rather than the optimistic set-pref
      // request — means a host that rolls the switch back keeps the saved node.
      const confirmedControlURL = msg.status.prefs?.controlURL ?? "";
      if (lastConfirmedControlURL === undefined) {
        lastConfirmedControlURL = confirmedControlURL;
      } else if (
        controlServerChanged(confirmedControlURL, lastConfirmedControlURL)
      ) {
        lastConfirmedControlURL = confirmedControlURL;
        void chrome.storage.local.remove("lastExitNodeID");
      }

      const loginURL = loginURLFromStatus(msg.status);
      if (pendingLoginOpen) {
        const allowedControlURL = msg.status.prefs?.controlURL ?? null;
        if (loginURL && isValidLoginURL(loginURL, allowedControlURL)) {
          clearPendingLoginOpen();
          chrome.tabs.create({ url: loginURL });
        } else if (
          loginURL &&
          isCustomControlURL(allowedControlURL) &&
          isDefaultOriginLoginURL(loginURL)
        ) {
          // A stale Tailscale-default login URL can briefly linger right after
          // switching to a custom server. Stay pending and wait for the fresh
          // URL the host is about to emit rather than giving up; the pending
          // timeout bounds the wait. Only a default-origin URL is treated as
          // stale — a genuinely-invalid custom URL falls through to the error
          // below instead of spinning silently.
        } else if (loginURL) {
          clearPendingLoginOpen();
          sendToastToPopup(
            "Could not open the login URL Tailscale returned.",
            "error",
          );
        } else if (msg.status.backendState === "Running") {
          clearPendingLoginOpen();
        }
      }

      // Restore saved exit node after reconnection
      if (
        !exitNodeRestoreAttempted &&
        msg.status.backendState === "Running" &&
        !msg.status.exitNode
      ) {
        exitNodeRestoreAttempted = true;
        chrome.storage.local.get("lastExitNodeID").then((result) => {
          const lastExitNodeID = result["lastExitNodeID"];
          if (typeof lastExitNodeID === "string" && lastExitNodeID) {
            console.log(
              "[Background] Restoring saved exit node:",
              lastExitNodeID
            );
            nativeHost.send({
              cmd: "set-exit-node",
              nodeID: lastExitNodeID,
            });
          }
        });
      } else if (msg.status.backendState === "Running" && msg.status.exitNode) {
        // Mark as attempted if already has an exit node
        exitNodeRestoreAttempted = true;
      }

      maybeAutoConnect(msg.status.backendState);
      maybeAutoDisconnect(msg.status.backendState);
    }

    // Profiles result
    if (msg.profiles) {
      store.update({
        currentProfile: msg.profiles.current,
        profiles: msg.profiles.profiles,
      });
    }

    // Exit node suggestion — store in state, do NOT auto-apply.
    // The popup picker surfaces this in a "Recommended" row; no toast needed.
    if (msg.exitNodeSuggestion) {
      store.update({ exitNodeSuggestion: msg.exitNodeSuggestion });
    }

    // File send progress
    if (msg.fileSendProgress) {
      if (msg.fileSendProgress.done) {
        if (msg.fileSendProgress.error) {
          store.update({
            helperDiagnostic: diagnosticFrom(
              "helper-file-send-error",
              msg.fileSendProgress.error,
            ),
          });
        }
        const message = msg.fileSendProgress.error
          ? "The helper could not send the file."
          : `File "${msg.fileSendProgress.name}" sent successfully`;
        sendToastToPopup(message, msg.fileSendProgress.error ? "error" : "info");
      } else {
        // In-progress: use persistent toast so it stays visible
        sendToastToPopup(
          `Sending "${msg.fileSendProgress.name}": ${msg.fileSendProgress.percent}%`,
          "info",
          true,
        );
      }
    }

    if (msg.diagnostic) {
      const body = msg.diagnostic.body.replace(/\n/g, " · ");
      const text = `${msg.diagnostic.title}: ${body}`;
      // Ping/netcheck diagnostics: ephemeral, longer read time than default toasts.
      sendToastToPopup(text, "info", false, 7000);
    }

    // Error from native host
    if (msg.error) {
      const safeCommand = /^[a-z][a-z0-9-]{0,48}$/.test(msg.error.cmd)
        ? msg.error.cmd
        : "unknown";
      store.update({
        helperDiagnostic: diagnosticFrom(
          `helper-command-${safeCommand}-error`,
          msg.error.message,
        ),
        ...(msg.error.cmd === "set-exit-node"
          ? { pendingExitNodeID: null }
          : {}),
      });

      if (msg.error.cmd === "suggest-exit-node") {
        // Recommendation is a passive feature: log the failure but don't
        // pollute the popup with a toast or set a sticky error.
        //
        // Do not clear `exitNodeSuggestion` here: suggest-exit-node replies
        // are not correlated to a specific request in this code path, so a
        // late error from an older request could otherwise erase a newer
        // successful recommendation.
        console.warn("[Background] suggest-exit-node failed");
      } else {
        if (msg.error.cmd === "login") {
          clearPendingLoginOpen();
        }
        sendToastToPopup(nativeCommandErrorCopy(msg.error.cmd), "error");
      }
    }
  }

  function handleNativeConnectionEvent(event: NativeConnectionEvent): void {
    if (event.type === "diagnostic") {
      store.update({
        helperDiagnostic: {
          diagnosticCode: event.diagnosticCode,
          diagnosticMessage: event.diagnosticMessage,
        },
      });
      return;
    }

    if (event.type === "connected") {
      // A valid reply clears browser-level connection failures and resets
      // backoff. Helper-reported/explicit incompatibility failures remain
      // until procRunning and init both succeed on this connection.
      sawHealthyProcRunning = false;
      sawHealthyInit = false;
      const currentFailure = store.getState().helperFailure;
      const keepFailure =
        currentFailure?.kind === "helper-reported-error" ||
        currentFailure?.kind === "helper-incompatible";
      store.update({
        hostConnected: true,
        reconnecting: false,
        helperFailure: keepFailure ? currentFailure : null,
      });
      return;
    }

    exitNodeRestoreAttempted = false;
    autoDisconnectAttempted = false;
    sawHealthyProcRunning = false;
    sawHealthyInit = false;
    clearPendingLoginOpen();

    const currentFailure = store.getState().helperFailure;
    const keepSpecificFailure =
      currentFailure?.kind === "helper-reported-error" ||
      currentFailure?.kind === "helper-incompatible";
    const helperFailure = keepSpecificFailure
      ? currentFailure
      : event.failure;
    const authoritative =
      helperFailure?.kind === "helper-unavailable" ||
      helperFailure?.kind === "helper-not-allowed" ||
      helperFailure?.kind === "helper-reported-error" ||
      helperFailure?.kind === "helper-incompatible";

    store.update({
      hostConnected: false,
      initialized: false,
      proxyPort: null,
      proxyEnabled: false,
      backendState: "NoState",
      hostVersion: null,
      helperVersionNotice: null,
      helperFailure,
      helperDiagnostic: helperFailure
        ? {
            diagnosticCode: helperFailure.diagnosticCode,
            diagnosticMessage: helperFailure.diagnosticMessage,
          }
        : store.getState().helperDiagnostic,
      reconnecting: !authoritative && event.reconnecting,
      supportsNetcheck: false,
      supportsPingPeer: false,
      supportsLogin: false,
      supportsCustomControlURL: false,
    });
  }

  // Records a connection decision everywhere it needs to live: the in-memory
  // mirror (synchronous, so nothing can race it), session storage (survives
  // service-worker restarts), and local storage (survives the session-storage
  // wipe an extension update performs; cleared again at browser startup).
  function enqueueIntentWrite(persistAcrossUpdate: boolean): Promise<void> {
    intentWriteChain = intentWriteChain.then(async () => {
      const value = sessionIntentMirror;
      if (value === undefined) return;
      try {
        await writeSessionIntent(value);
      } catch (err) {
        console.warn("[Background] writeSessionIntent failed:", err);
      }
      if (persistAcrossUpdate) {
        try {
          await writePersistedIntent(value);
        } catch (err) {
          console.warn("[Background] writePersistedIntent failed:", err);
        }
      }
    });
    return intentWriteChain;
  }

  function recordIntent(value: boolean): void {
    sessionIntentMirror = value;
    intentExplicitlyDecided = true;
    void enqueueIntentWrite(true);
  }

  // Forgets the recorded decision when the user changes profiles: it was made
  // for the previous profile, and the incoming profile's own saved prefs
  // decide its run state (the host cancels its startup correction for the
  // same reason). Also closes the corrective-down window for this connection
  // synchronously — a stay-down intent from the old profile must not yank
  // down a profile the user just switched to, even from a storage read
  // already in flight.
  function clearIntent(): void {
    sessionIntentMirror = undefined;
    intentExplicitlyDecided = true;
    autoDisconnectAttempted = true;
    intentWriteChain = intentWriteChain.then(async () => {
      // A decision recorded after this clear was queued is newer — keep it.
      if (sessionIntentMirror !== undefined) return;
      try {
        await clearSessionIntent();
      } catch (err) {
        console.warn("[Background] clearSessionIntent failed:", err);
      }
      try {
        await clearPersistedIntent();
      } catch (err) {
        console.warn("[Background] clearPersistedIntent failed:", err);
      }
    });
  }

  const nativeHost = new NativeHostConnection(
    nativeHostId,
    handleNativeMessage,
    handleNativeConnectionEvent,
    timerService,
    async () => {
      // A decision already made this lifetime is fresher than storage — a
      // reconnect must restore it even when the session write had failed.
      if (sessionIntentMirror !== undefined) return sessionIntentMirror;
      const sessionIntent = await readSessionIntent();
      let resolved: boolean;
      if (sessionIntent !== undefined) {
        resolved = sessionIntent;
      } else {
        const [pref, persisted] = await Promise.all([
          readAutoConnectPref(),
          readPersistedIntent(),
        ]);
        if (persisted !== undefined) {
          await runtimeLifecycleSettled;
        }
        if (sawBrowserStartup) {
          await startupClearPromise;
        }
        const recoverUpdateIntent =
          persisted !== undefined && sawExtensionUpdate && !sawBrowserStartup;
        resolved = recoverUpdateIntent ? persisted : pref;
        startupResolution = {
          pref,
          persisted,
          usedRecovery: recoverUpdateIntent,
        };
      }
      // A user action that landed while the resolution was in flight wins.
      sessionIntentMirror ??= resolved;
      await enqueueIntentWrite(false);
      return sessionIntentMirror;
    },
  );

  // Start the connection
  nativeHost.connect().catch((err) => {
    console.error("[Background] Initial connection failed:", err);
  });

  function broadcastToPopup(state: TailscaleState): void {
    const msg: PopupMessage = { type: "state", state };
    for (const port of popupPorts) {
      try {
        port.postMessage(msg);
      } catch {
        popupPorts.delete(port);
      }
    }
  }

  function sendToastToPopup(
    message: string,
    level: "info" | "error",
    persistent = false,
    dismissMs?: number,
    multiline = false,
  ): void {
    for (const port of popupPorts) {
      try {
        const popupMsg: PopupMessage = {
          type: "toast",
          message,
          level,
          persistent,
          ...(dismissMs != null ? { dismissMs } : {}),
          ...(multiline ? { multiline: true } : {}),
        };
        port.postMessage(popupMsg);
      } catch {
        // Port may have disconnected
      }
    }
  }

  // Fire `up` once per browser session when the pref is enabled and the node
  // is in a state we can act on. The session flag (set by markAutoConnectHandled)
  // ensures an explicit manual disconnect within the same browser session is
  // respected even when the service worker cycles.
  function maybeAutoConnect(backendState: TailscaleState["backendState"]): void {
    if (!store.getState().autoConnectOnStart) return;
    if (!shouldAutoConnect(backendState)) return;
    // A synchronous decision is newer than the session flag and closes the
    // window where an update-restored/manual disconnect is still waiting for
    // its asynchronous handled-marker write.
    if (sessionIntentMirror === false) return;
    void isAutoConnectHandled()
      .then((handled) => {
        if (handled) return;
        return markAutoConnectHandled().then(() => {
          // Record the intent before sending so the auto-disconnect fallback
          // can never read a stale "stay down" while this `up` is in flight.
          recordIntent(true);
          if (!nativeHost.send({ cmd: "up" })) {
            sendToastToPopup(NATIVE_HOST_UNREACHABLE, "error");
          }
        });
      })
      .catch((err) => {
        console.warn("[Background] auto-connect failed:", err);
      });
  }

  // Fallback for the wantRunning init hint being ignored: helpers that
  // predate the field (patch-version differences are tolerated, so an
  // extension-only update still talks to them) and a host that failed to
  // apply WantRunning=false at init both bring the node up against a
  // stay-down decision. The mirror is authoritative when set — every user
  // action updates it synchronously, so unlike a storage read it can never
  // lag behind a click and yank down a node the user just brought up.
  function maybeAutoDisconnect(
    backendState: TailscaleState["backendState"],
  ): void {
    if (backendState !== "Starting" && backendState !== "Running") return;
    if (autoDisconnectAttempted) return;
    if (sessionIntentMirror !== undefined) {
      if (sessionIntentMirror === false) sendCorrectiveDown();
      return;
    }
    void readSessionIntent()
      .then((intent) => {
        if (intent !== false) return;
        if (autoDisconnectAttempted) return;
        // A user action that landed while the read was in flight wins.
        if (sessionIntentMirror === true) return;
        sessionIntentMirror = false;
        sendCorrectiveDown();
      })
      .catch((err) => {
        console.warn("[Background] auto-disconnect failed:", err);
      });
  }

  function sendCorrectiveDown(): void {
    autoDisconnectAttempted = true;
    if (!nativeHost.send({ cmd: "down" })) {
      // Port already gone: the disconnect handler resets the latch and the
      // next connection gets its own corrective window.
      autoDisconnectAttempted = false;
    }
  }

  function writeHelperRetryRecord(record: HelperRetryRecord): Promise<void> {
    helperRetryRecord = record;
    return chrome.storage.session.set({
      [HELPER_RETRY_STORAGE_KEY]: record,
    });
  }

  function armHelperRetry(record: HelperRetryRecord): void {
    helperRetryRecord = record;
    const callback = () => executeHelperRetry(record);
    if (timerService.setTimeoutAt) {
      timerService.setTimeoutAt(
        HELPER_RETRY_TIMER_NAME,
        callback,
        record.nextRetryAt,
      );
    } else {
      timerService.setTimeout(
        HELPER_RETRY_TIMER_NAME,
        callback,
        Math.max(0, record.nextRetryAt - Date.now()),
      );
    }
  }

  function persistAndArmHelperRetry(record: HelperRetryRecord): void {
    void writeHelperRetryRecord(record)
      .then(() => armHelperRetry(record))
      .catch((err) => {
        console.warn(
          `[Background] Could not persist helper retry: ${sanitizeDiagnosticMessage(err) ?? "unknown"}`,
        );
        armHelperRetry(record);
      });
  }

  function finishUnsuccessfulHelperRetries(source: HelperRetrySource): void {
    helperRetryRecord = null;
    timerService.clear(HELPER_RETRY_TIMER_NAME);
    void chrome.storage.session.remove(HELPER_RETRY_STORAGE_KEY);
    const state = store.getState();
    const failureKind = state.helperFailure?.kind;
    if (
      source === "manual" ||
      state.hostConnected ||
      (failureKind !== "helper-unavailable" &&
        failureKind !== "helper-not-allowed")
    ) {
      return;
    }

    store.update({ repairRegistrationAvailable: true });
    void chrome.storage.session
      .set({ [HELPER_REPAIR_STORAGE_KEY]: true })
      .catch((err) => {
        console.warn(
          `[Background] Could not persist registration repair state: ${sanitizeDiagnosticMessage(err) ?? "unknown"}`,
        );
      });
  }

  function executeHelperRetry(expected: HelperRetryRecord): void {
    const current = helperRetryRecord;
    if (
      !current ||
      current.source !== expected.source ||
      current.nextRetryIndex !== expected.nextRetryIndex ||
      current.nextRetryAt !== expected.nextRetryAt
    ) {
      return;
    }
    if (store.getState().hostConnected) {
      void clearHelperRetryStorage();
      return;
    }
    if (current.nextRetryIndex >= INSTALL_RETRY_DELAYS_MS.length) {
      finishUnsuccessfulHelperRetries(current.source);
      return;
    }

    void nativeHost.connect();
    const nextRetryIndex = current.nextRetryIndex + 1;
    const delay =
      nextRetryIndex < INSTALL_RETRY_DELAYS_MS.length
        ? INSTALL_RETRY_DELAYS_MS[nextRetryIndex]!
        : INSTALL_RETRY_SETTLE_MS;
    persistAndArmHelperRetry({
      source: current.source,
      nextRetryIndex,
      nextRetryAt: Date.now() + delay,
    });
  }

  function startHelperRetries(source: HelperRetrySource): void {
    timerService.clear(HELPER_RETRY_TIMER_NAME);
    if (source !== "manual") {
      store.update({ repairRegistrationAvailable: false });
      void chrome.storage.session.remove(HELPER_REPAIR_STORAGE_KEY);
    }
    if (source === "manual") {
      void nativeHost.connect();
    }
    persistAndArmHelperRetry({
      source,
      nextRetryIndex: 0,
      nextRetryAt: Date.now() + INSTALL_RETRY_DELAYS_MS[0]!,
    });
  }

  async function rehydrateHelperRetries(): Promise<void> {
    const stored = await chrome.storage.session.get([
      HELPER_RETRY_STORAGE_KEY,
      HELPER_REPAIR_STORAGE_KEY,
    ]);
    if (stored[HELPER_REPAIR_STORAGE_KEY] === true) {
      store.update({ repairRegistrationAvailable: true });
    }
    const record = stored[HELPER_RETRY_STORAGE_KEY];
    if (!isHelperRetryRecord(record)) return;
    helperRetryRecord = record;
    if (store.getState().hostConnected) {
      await clearHelperRetryStorage();
      return;
    }
    if (record.nextRetryAt <= Date.now()) {
      executeHelperRetry(record);
      return;
    }
    armHelperRetry(record);
  }

  chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
    if (port.name !== "popup") return;

    popupPorts.add(port);

    // Immediately send current state to the newly connected popup
    const stateMsg: PopupMessage = {
      type: "state",
      state: store.getState(),
    };
    try {
      port.postMessage(stateMsg);
    } catch {
      popupPorts.delete(port);
      return;
    }

    port.onMessage.addListener((msg: BackgroundMessage) => {
      handlePopupMessage(msg);
    });

    port.onDisconnect.addListener(() => {
      popupPorts.delete(port);
    });
  });

  function handlePopupMessage(msg: BackgroundMessage): void {
    const state = store.getState();

    switch (msg.type) {
      case "toggle": {
        if (state.backendState === "Running") {
          // Treat manual disconnect as an explicit decision so a later SW
          // restart doesn't trip auto-connect and undo it within the session.
          void markAutoConnectHandled().catch((err) => {
            console.warn("[Background] markAutoConnectHandled failed:", err);
          });
          recordIntent(false);
          if (!nativeHost.send({ cmd: "down" })) {
            sendToastToPopup(NATIVE_HOST_UNREACHABLE, "error");
          }
        } else if (
          state.backendState === "Stopped" ||
          state.backendState === "NoState"
        ) {
          recordIntent(true);
          if (!nativeHost.send({ cmd: "up" })) {
            sendToastToPopup(NATIVE_HOST_UNREACHABLE, "error");
          }
        } else if (state.backendState === "Starting") {
          sendToastToPopup("Tailscale is starting up\u2026", "info");
        } else if (state.backendState === "NeedsLogin") {
          sendToastToPopup("Please log in to Tailscale first.", "info");
        } else if (state.backendState === "NeedsMachineAuth") {
          sendToastToPopup("This machine needs admin approval to join the tailnet.", "error");
        } else if (state.backendState === "InUseOtherUser") {
          sendToastToPopup("Tailscale is in use by another user on this machine.", "error");
        }
        break;
      }

      case "login": {
        if (pendingLoginOpen) {
          sendToastToPopup("Still waiting for Tailscale to return a login URL.", "info");
          break;
        }
        // Logging in is an explicit request to bring the node online, and
        // helpers that predate the wantRunning hint connect right after auth.
        // Record the intent so a later host respawn or the auto-disconnect
        // fallback doesn't yank a freshly logged-in user offline.
        recordIntent(true);
        if (
          state.browseToURL &&
          isValidLoginURL(state.browseToURL, state.prefs?.controlURL ?? null)
        ) {
          chrome.tabs.create({ url: state.browseToURL });
        } else if (!state.supportsLogin) {
          sendToastToPopup(
            "Please update the native helper to request a fresh Tailscale login URL.",
            "error",
          );
        } else if (!nativeHost.send({ cmd: "login" })) {
          clearPendingLoginOpen();
          sendToastToPopup(
            "Could not request a Tailscale login URL. Please check that the native host is installed.",
            "error",
          );
        } else {
          startPendingLoginOpen();
        }
        break;
      }

      case "logout": {
        nativeHost.send({ cmd: "logout" });
        break;
      }

      case "retry-native-host": {
        startHelperRetries(msg.source);
        break;
      }

      case "open-admin": {
        chrome.tabs.create({ url: ADMIN_URL });
        break;
      }

      case "open-web-client": {
        chrome.tabs.create({ url: `http://${TAILSCALE_SERVICE_IP}` });
        break;
      }

      case "set-exit-node": {
        store.update({ pendingExitNodeID: msg.nodeID });
        nativeHost.send({ cmd: "set-exit-node", nodeID: msg.nodeID });
        chrome.storage.local.set({ lastExitNodeID: msg.nodeID });
        break;
      }

      case "clear-exit-node": {
        store.update({ pendingExitNodeID: "" });
        nativeHost.send({ cmd: "set-exit-node", nodeID: "" });
        chrome.storage.local.remove("lastExitNodeID");
        break;
      }

      case "set-pref": {
        if (msg.key === "controlURL") {
          // Reverting to the default server ("") is always allowed; only
          // switching to a custom server requires native-helper support.
          if (!state.supportsCustomControlURL && msg.value !== "") {
            sendToastToPopup(
              "Please update the native helper to change the coordination server.",
              "error",
            );
            break;
          }
          // Validate at the trust boundary, not only on the popup's Save button.
          if (msg.value !== "" && !isValidControlURL(msg.value)) {
            sendToastToPopup(
              "Enter a valid coordination server URL (http:// or https://).",
              "error",
            );
            break;
          }
          // Switching coordination servers invalidates the cached login URL
          // (stale until the host replies), so drop it now for an immediate Log
          // In. The saved exit-node ID is dropped reactively once the host
          // *confirms* the change (see the status handler) rather than here, so
          // a rolled-back switch doesn't permanently lose it.
          if (controlServerChanged(msg.value, state.prefs?.controlURL)) {
            store.update({ browseToURL: "" });
          }
        }
        nativeHost.send({
          cmd: "set-prefs",
          prefs: { [msg.key]: msg.value },
        });
        break;
      }

      case "switch-profile": {
        clearIntent();
        nativeHost.send({ cmd: "switch-profile", profileID: msg.profileID });
        break;
      }

      case "new-profile": {
        clearIntent();
        nativeHost.send({ cmd: "new-profile" });
        break;
      }

      case "delete-profile": {
        // Deleting the current profile implicitly switches profiles; deleting
        // another profile leaves the current decision in force.
        if (state.currentProfile?.id === msg.profileID) {
          clearIntent();
        }
        nativeHost.send({
          cmd: "delete-profile",
          profileID: msg.profileID,
        });
        break;
      }

      case "send-file": {
        nativeHost.send({
          cmd: "send-file",
          nodeID: msg.targetNodeID,
          fileName: msg.name,
          fileData: msg.dataBase64,
          fileSize: msg.size,
          ...(msg.transferID !== undefined
            ? {
                transferID: msg.transferID,
                chunkIndex: msg.chunkIndex,
                chunkCount: msg.chunkCount,
              }
            : {}),
        });
        break;
      }

      case "suggest-exit-node": {
        nativeHost.send({ cmd: "suggest-exit-node" });
        break;
      }

      case "ping-peer": {
        nativeHost.send({ cmd: "ping-peer", nodeID: msg.nodeID });
        break;
      }

      case "netcheck": {
        nativeHost.send({ cmd: "netcheck" });
        break;
      }

      case "set-advertise-routes": {
        nativeHost.send({ cmd: "set-prefs", prefs: { advertiseRoutes: msg.routes } });
        break;
      }

      case "set-auto-connect-on-start": {
        store.update({ autoConnectOnStart: msg.value });
        void writeAutoConnectPref(msg.value).catch((err) => {
          console.warn("[Background] writeAutoConnectPref failed:", err);
        });
        break;
      }

      case "set-domain-split": {
        const next = normalizeDomainSplit(msg.config);
        store.update({ domainSplit: next });
        void writeDomainSplit(next).catch((err) => {
          console.warn("[Background] writeDomainSplit failed:", err);
        });
        break;
      }

      default: {
        // Exhaustiveness check: TypeScript will error if a case is missing
        const _exhaustive: never = msg;
        console.warn("[Background] Unknown popup message:", _exhaustive);
      }
    }
  }

  if (!options?.skipKeepalive) {
    timerService.setInterval("keepalive", () => {
      if (store.getState().hostConnected) {
        nativeHost.send({ cmd: "ping" });
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId !== "tailscale-send-page") return;

    const state = store.getState();
    if (state.backendState !== "Running") return;

    const url = info.pageUrl;
    if (!url) return;

    // Find the first online peer that supports Taildrop
    const targets = state.peers.filter((p) => p.online && p.taildropTarget);
    if (targets.length === 0) return;

    // Send the URL as a text file to the first available peer
    const target = targets[0]!;
    const fileName = "shared-url.txt";
    const encoded = btoa(unescape(encodeURIComponent(url)));
    nativeHost.send({
      cmd: "send-file",
      nodeID: target.id,
      fileName,
      fileData: encoded,
      fileSize: new TextEncoder().encode(url).byteLength,
    });
  });

  return {
    proxyManager,
    sendKeepalive() {
      if (store.getState().hostConnected) {
        nativeHost.send({ cmd: "ping" });
      }
    },
    reconnect() {
      return nativeHost.connect();
    },
    rehydrateHelperRetries,
  };
}
