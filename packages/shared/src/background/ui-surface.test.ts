import { describe, it, expect, vi, beforeEach } from "vitest";
import { readUiSurface, writeUiSurface } from "./ui-surface";

describe("ui-surface setting", () => {
  beforeEach(() => {
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      () => Promise.resolve({}),
    );
    (chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      () => Promise.resolve(),
    );
  });

  it("readUiSurface returns 'popup' when nothing is stored", async () => {
    expect(await readUiSurface()).toBe("popup");
  });

  it("readUiSurface returns the stored value", async () => {
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      () => Promise.resolve({ uiSurface: "sidePanel" }),
    );
    expect(await readUiSurface()).toBe("sidePanel");
  });

  it("readUiSurface coerces an unknown stored value to 'popup'", async () => {
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      () => Promise.resolve({ uiSurface: "garbage" }),
    );
    expect(await readUiSurface()).toBe("popup");
  });

  it("writeUiSurface persists the value to storage.local", async () => {
    const setSpy = vi.fn(() => Promise.resolve());
    (chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>) = setSpy;
    await writeUiSurface("sidePanel");
    expect(setSpy).toHaveBeenCalledWith({ uiSurface: "sidePanel" });
  });
});

import { applyUiSurface } from "./ui-surface";

describe("applyUiSurface — Chrome", () => {
  beforeEach(() => {
    (chrome.sidePanel.setPanelBehavior as ReturnType<typeof vi.fn>).mockClear();
    (chrome.action.setPopup as ReturnType<typeof vi.fn>).mockClear();
  });

  it("opens the panel on action click when set to sidePanel", async () => {
    await applyUiSurface("sidePanel", "chrome");
    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({
      openPanelOnActionClick: true,
    });
  });

  it("restores popup behaviour when set to popup", async () => {
    await applyUiSurface("popup", "chrome");
    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({
      openPanelOnActionClick: false,
    });
  });

  it("does not call action.setPopup on Chrome", async () => {
    await applyUiSurface("sidePanel", "chrome");
    expect(chrome.action.setPopup).not.toHaveBeenCalled();
  });
});

describe("applyUiSurface — Firefox", () => {
  beforeEach(() => {
    (chrome.sidePanel.setPanelBehavior as ReturnType<typeof vi.fn>).mockClear();
    (chrome.action.setPopup as ReturnType<typeof vi.fn>).mockClear();
  });

  it("clears the popup so the toolbar click fires onClicked when set to sidePanel", async () => {
    await applyUiSurface("sidePanel", "firefox");
    expect(chrome.action.setPopup).toHaveBeenCalledWith({ popup: "" });
  });

  it("restores popup.html when set to popup", async () => {
    await applyUiSurface("popup", "firefox");
    expect(chrome.action.setPopup).toHaveBeenCalledWith({ popup: "popup.html" });
  });

  it("does not call sidePanel.setPanelBehavior on Firefox", async () => {
    await applyUiSurface("sidePanel", "firefox");
    expect(chrome.sidePanel.setPanelBehavior).not.toHaveBeenCalled();
  });
});

import { registerSidebarOpener } from "./ui-surface";

describe("registerSidebarOpener (Firefox)", () => {
  beforeEach(() => {
    (chrome.sidebarAction.open as ReturnType<typeof vi.fn>).mockClear();
  });

  it("opens the sidebar when toolbar click fires while in sidePanel mode", async () => {
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      () => Promise.resolve({ uiSurface: "sidePanel" }),
    );
    registerSidebarOpener();
    const listeners =
      (chrome.action.onClicked as unknown as { _listeners: Array<(tab: unknown) => void> })
        ._listeners;
    await listeners[listeners.length - 1]({});
    expect(chrome.sidebarAction.open).toHaveBeenCalledTimes(1);
  });

  it("does NOT open the sidebar when in popup mode (popup handles the click)", async () => {
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      () => Promise.resolve({ uiSurface: "popup" }),
    );
    registerSidebarOpener();
    const listeners =
      (chrome.action.onClicked as unknown as { _listeners: Array<(tab: unknown) => void> })
        ._listeners;
    await listeners[listeners.length - 1]({});
    expect(chrome.sidebarAction.open).not.toHaveBeenCalled();
  });
});
