import type { BackendState } from "../types";

export const AUTO_CONNECT_PREF_KEY = "autoConnectOnStart";
const SESSION_KEY = "autoConnectHandled";

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

// Backend states where sending `up` is the right action to bring the node online.
// `NeedsLogin` / `NeedsMachineAuth` require user-driven flows; `Starting` / `Running`
// are already moving toward connected; `InUseOtherUser` is not actionable here.
export function shouldAutoConnect(state: BackendState): boolean {
  return state === "Stopped" || state === "NoState";
}
