export type UiSurface = "popup" | "sidePanel";

const STORAGE_KEY = "uiSurface";
const VALID_VALUES: ReadonlySet<UiSurface> = new Set(["popup", "sidePanel"]);

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

export type BrowserKind = "chrome" | "firefox";

export async function applyUiSurface(
  surface: UiSurface,
  browserKind: BrowserKind,
): Promise<void> {
  if (browserKind === "chrome") {
    await chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: surface === "sidePanel",
    });
    return;
  }
  // Firefox: clear the popup so the toolbar click fires action.onClicked,
  // which the background opens the sidebar from. Restore "popup.html" to
  // bring the popup back.
  await chrome.action.setPopup({
    popup: surface === "sidePanel" ? "" : "popup.html",
  });
}

// Firefox-only. Safe to call on Chrome too — Chrome routes toolbar clicks
// through the popup or side-panel behaviour, so the listener never fires
// for a popup-less click in side-panel mode.
export function registerSidebarOpener(): void {
  chrome.action.onClicked.addListener(async () => {
    const surface = await readUiSurface();
    if (surface !== "sidePanel") return;
    if (typeof chrome.sidebarAction?.open !== "function") return;
    await chrome.sidebarAction.open();
  });
}
