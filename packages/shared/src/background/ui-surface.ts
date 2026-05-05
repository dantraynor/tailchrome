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

export async function applyUiSurface(
  surface: UiSurface,
  browserKind: BrowserKind,
): Promise<void> {
  if (browserKind === "chrome") {
    // chrome.sidePanel was added in Chrome 114; older Chromium builds may
    // install the extension without the API. Skip silently in that case
    // so background startup can't crash on the missing global.
    if (typeof chrome.sidePanel?.setPanelBehavior !== "function") return;
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

// Firefox-only. MUST be registered synchronously at service-worker top-level
// so a toolbar click that wakes a dormant SW is delivered to the listener.
// The handler is unconditionally sync: action.onClicked only fires on Firefox
// when setPopup has been cleared (= side-panel mode), so the popup-mode case
// can't reach this code, and we don't need to consult any cached state that
// might not be ready yet on cold start.
export function registerSidebarOpener(): void {
  chrome.action.onClicked.addListener(() => {
    if (!sidebarAction || typeof sidebarAction.open !== "function") return;
    void sidebarAction.open();
  });
}
