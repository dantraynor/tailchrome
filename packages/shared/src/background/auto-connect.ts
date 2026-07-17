import type { BackendState } from "../types";

export const AUTO_CONNECT_PREF_KEY = "autoConnectOnStart";
const SESSION_KEY = "autoConnectHandled";
const INTENT_KEY = "desiredWantRunning";

// `chrome.storage.session` is MV3-only and may be missing on older builds.
// Resolve lazily so the module loads even if the API is absent.
function sessionArea(): chrome.storage.StorageArea | undefined {
  return chrome.storage?.session;
}

export async function readAutoConnectPref(): Promise<boolean> {
  const result = await chrome.storage.local.get(AUTO_CONNECT_PREF_KEY);
  return result[AUTO_CONNECT_PREF_KEY] === true;
}

export async function writeAutoConnectPref(value: boolean): Promise<void> {
  await chrome.storage.local.set({ [AUTO_CONNECT_PREF_KEY]: value });
}

export async function isAutoConnectHandled(): Promise<boolean> {
  const area = sessionArea();
  if (!area) return false;
  const result = await area.get(SESSION_KEY);
  return result[SESSION_KEY] === true;
}

export async function markAutoConnectHandled(): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  await area.set({ [SESSION_KEY]: true });
}

// Session-scoped record of the last connection decision: the auto-connect
// choice made at browser launch, or an explicit user toggle afterwards. Sent
// as the `wantRunning` hint with host init so a host respawn mid-session
// restores what the user last chose instead of tsnet's forced auto-up.
export async function readSessionIntent(): Promise<boolean | undefined> {
  const area = sessionArea();
  if (!area) return undefined;
  const result = await area.get(INTENT_KEY);
  const value = result[INTENT_KEY];
  return typeof value === "boolean" ? value : undefined;
}

export async function writeSessionIntent(value: boolean): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  await area.set({ [INTENT_KEY]: value });
}

// Resolves the `wantRunning` hint for host init: the in-session intent when
// one is recorded, otherwise the persisted auto-connect preference. The
// fallback is recorded as the session intent so flipping the preference
// mid-session doesn't change what a host respawn restores.
export async function resolveStartupWantRunning(): Promise<boolean> {
  const intent = await readSessionIntent();
  if (intent !== undefined) return intent;
  const pref = await readAutoConnectPref();
  // The session cache is an optimization; a failed write must not discard
  // the resolved preference (dropping the hint would let the node auto-up).
  try {
    await writeSessionIntent(pref);
  } catch (err) {
    console.warn("[AutoConnect] failed to cache session intent:", err);
  }
  return pref;
}

// Backend states where sending `up` is the right action to bring the node online.
// `NeedsLogin` / `NeedsMachineAuth` require user-driven flows; `Starting` / `Running`
// are already moving toward connected; `InUseOtherUser` is not actionable here.
export function shouldAutoConnect(state: BackendState): boolean {
  return state === "Stopped" || state === "NoState";
}
