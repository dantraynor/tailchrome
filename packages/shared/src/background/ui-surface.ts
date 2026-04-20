export type UiSurface = "popup" | "sidePanel";
export type BrowserKind = "chrome" | "firefox";

const STORAGE_KEY = "uiSurface";
const VALID_VALUES: ReadonlySet<UiSurface> = new Set(["popup", "sidePanel"]);
// Keep in sync with the WXT popup entrypoint name (popup.html).
const POPUP_PATH = "popup.html";

// Firefox-only: @types/chrome doesn't declare this. Captured at module load
// so the synchronous click handler below never has to pay a property lookup
// that TypeScript can't verify.
type SidebarActionGlobal = { open(): Promise<void> } | undefined;
const sidebarAction = (chrome as typeof chrome & {
  sidebarAction?: SidebarActionGlobal;
}).sidebarAction;

// Synchronously-readable mirror of the stored preference. Firefox's
// action.onClicked must call sidebarAction.open() inside the user-gesture
// window — awaiting storage.local.get between the click and the call will
// consume the gesture token and the open rejects.
let cachedSurface: UiSurface = "popup";

export async function readUiSurface(): Promise<UiSurface> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY];
  return typeof stored === "string" && VALID_VALUES.has(stored as UiSurface)
    ? (stored as UiSurface)
    : "popup";
}

export async function writeUiSurface(value: UiSurface): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: value });
}

export function getCachedUiSurface(): UiSurface {
  return cachedSurface;
}

// Exposed for test setup; production code updates the cache via applyUiSurface.
export function setCachedUiSurface(value: UiSurface): void {
  cachedSurface = value;
}

export async function applyUiSurface(
  surface: UiSurface,
  browserKind: BrowserKind,
): Promise<void> {
  cachedSurface = surface;
  if (browserKind === "chrome") {
    await chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: surface === "sidePanel",
    });
    return;
  }
  // Firefox: clear the popup so the toolbar click fires action.onClicked,
  // which the background opens the sidebar from. Restore POPUP_PATH to
  // bring the popup back.
  await chrome.action.setPopup({
    popup: surface === "sidePanel" ? "" : POPUP_PATH,
  });
}

// Firefox-only. Registered by background startup when browserKind === "firefox".
// The click handler MUST run synchronously to preserve the user-gesture token
// that sidebarAction.open() requires.
export function registerSidebarOpener(): void {
  chrome.action.onClicked.addListener(() => {
    if (cachedSurface !== "sidePanel") return;
    if (!sidebarAction || typeof sidebarAction.open !== "function") return;
    void sidebarAction.open();
  });
}
