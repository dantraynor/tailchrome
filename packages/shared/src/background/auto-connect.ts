import type { BackendState } from "../types";

export const AUTO_CONNECT_PREF_KEY = "autoConnectOnStart";
const SESSION_KEY = "autoConnectHandled";
const INTENT_KEY = "desiredWantRunning";
const LAST_INTENT_KEY = "lastSessionWantRunning";

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

export async function clearSessionIntent(): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  await area.remove(INTENT_KEY);
}

// Local-storage copy of the session intent. chrome.storage.session is wiped
// not only at browser restart but also when the extension is updated or
// reloaded mid-session; this copy is what lets the update corrector in
// background.ts tell those apart and restore a connection the user had
// started. Cleared at browser startup (runtime.onStartup) so a genuinely
// fresh session is governed by the auto-connect preference alone.
export async function readPersistedIntent(): Promise<boolean | undefined> {
  const result = await chrome.storage.local.get(LAST_INTENT_KEY);
  const value = result[LAST_INTENT_KEY];
  return typeof value === "boolean" ? value : undefined;
}

export async function writePersistedIntent(value: boolean): Promise<void> {
  await chrome.storage.local.set({ [LAST_INTENT_KEY]: value });
}

export async function clearPersistedIntent(): Promise<void> {
  await chrome.storage.local.remove(LAST_INTENT_KEY);
}

// Backend states where sending `up` is the right action to bring the node online.
// `NeedsLogin` / `NeedsMachineAuth` require user-driven flows; `Starting` / `Running`
// are already moving toward connected; `InUseOtherUser` is not actionable here.
export function shouldAutoConnect(state: BackendState): boolean {
  return state === "Stopped" || state === "NoState";
}
