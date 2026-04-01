import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadgeManager } from "./badge-manager";
import { baseState } from "../__test__/fixtures";

describe("BadgeManager", () => {
  let setIconSpy: ReturnType<typeof vi.fn>;
  let setBadgeTextSpy: ReturnType<typeof vi.fn>;
  let setBadgeColorSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setIconSpy = vi.fn().mockResolvedValue(undefined);
    setBadgeTextSpy = vi.fn();
    setBadgeColorSpy = vi.fn();
    chrome.action.setIcon = setIconSpy;
    chrome.action.setBadgeText = setBadgeTextSpy;
    chrome.action.setBadgeBackgroundColor = setBadgeColorSpy;
  });

  describe("Running state", () => {
    it("sets online icons and clears badge when running without exit node", () => {
      const mgr = new BadgeManager();
      mgr.update(baseState());

      expect(setIconSpy).toHaveBeenCalledWith({
        path: expect.objectContaining({ 16: "icons/icon-16.png" }),
      });
      expect(setBadgeTextSpy).toHaveBeenCalledWith({ text: "" });
    });

    it("shows EN badge when exit node is active", () => {
      const mgr = new BadgeManager();
      mgr.update(
        baseState({
          exitNode: { id: "exit1", hostname: "exit-node", location: null, online: true },
        })
      );

      expect(setIconSpy).toHaveBeenCalledWith({
        path: expect.objectContaining({ 16: "icons/icon-16.png" }),
      });
      expect(setBadgeTextSpy).toHaveBeenCalledWith({ text: "EN" });
      expect(setBadgeColorSpy).toHaveBeenCalledWith({ color: "#4C78C6" });
    });
  });

  describe("Disconnected state", () => {
    it("sets offline icons when host not connected", () => {
      const mgr = new BadgeManager();
      mgr.update(baseState({ hostConnected: false }));

      expect(setIconSpy).toHaveBeenCalledWith({
        path: expect.objectContaining({ 16: "icons/icon-16-offline.png" }),
      });
      expect(setBadgeTextSpy).toHaveBeenCalledWith({ text: "" });
    });

    it("sets offline icons when backend is Stopped", () => {
      const mgr = new BadgeManager();
      mgr.update(baseState({ backendState: "Stopped" }));

      expect(setIconSpy).toHaveBeenCalledWith({
        path: expect.objectContaining({ 16: "icons/icon-16-offline.png" }),
      });
    });
  });

  describe("Install error state", () => {
    it("shows warning icon with ! badge on install error", () => {
      const mgr = new BadgeManager();
      mgr.update(baseState({ installError: true }));

      expect(setIconSpy).toHaveBeenCalledWith({
        path: expect.objectContaining({ 16: "icons/icon-16-warning.png" }),
      });
      expect(setBadgeTextSpy).toHaveBeenCalledWith({ text: "!" });
      expect(setBadgeColorSpy).toHaveBeenCalledWith({ color: "#E5832A" });
    });
  });

  describe("NeedsLogin state", () => {
    it("shows offline icons with ? badge", () => {
      const mgr = new BadgeManager();
      mgr.update(baseState({ backendState: "NeedsLogin" }));

      expect(setIconSpy).toHaveBeenCalledWith({
        path: expect.objectContaining({ 16: "icons/icon-16-offline.png" }),
      });
      expect(setBadgeTextSpy).toHaveBeenCalledWith({ text: "?" });
      expect(setBadgeColorSpy).toHaveBeenCalledWith({ color: "#4C78C6" });
    });

    it("shows ? badge for NeedsMachineAuth state", () => {
      const mgr = new BadgeManager();
      mgr.update(baseState({ backendState: "NeedsMachineAuth" }));

      expect(setBadgeTextSpy).toHaveBeenCalledWith({ text: "?" });
    });
  });

  describe("Starting state", () => {
    it("shows offline icons with ... badge", () => {
      const mgr = new BadgeManager();
      mgr.update(baseState({ backendState: "Starting" }));

      expect(setIconSpy).toHaveBeenCalledWith({
        path: expect.objectContaining({ 16: "icons/icon-16-offline.png" }),
      });
      expect(setBadgeTextSpy).toHaveBeenCalledWith({ text: "..." });
      expect(setBadgeColorSpy).toHaveBeenCalledWith({ color: "#888888" });
    });
  });

  describe("Unknown/default states", () => {
    it("shows offline icons for NoState", () => {
      const mgr = new BadgeManager();
      mgr.update(baseState({ backendState: "NoState" }));

      expect(setIconSpy).toHaveBeenCalledWith({
        path: expect.objectContaining({ 16: "icons/icon-16-offline.png" }),
      });
      expect(setBadgeTextSpy).toHaveBeenCalledWith({ text: "" });
    });

    it("shows offline icons for InUseOtherUser", () => {
      const mgr = new BadgeManager();
      mgr.update(baseState({ backendState: "InUseOtherUser" }));

      expect(setIconSpy).toHaveBeenCalledWith({
        path: expect.objectContaining({ 16: "icons/icon-16-offline.png" }),
      });
    });
  });

  describe("deduplication", () => {
    it("skips update when badge key has not changed", () => {
      const mgr = new BadgeManager();
      mgr.update(baseState());
      setIconSpy.mockClear();
      setBadgeTextSpy.mockClear();

      // Same state again
      mgr.update(baseState());
      expect(setIconSpy).not.toHaveBeenCalled();
      expect(setBadgeTextSpy).not.toHaveBeenCalled();
    });

    it("updates when state changes", () => {
      const mgr = new BadgeManager();
      mgr.update(baseState());
      setIconSpy.mockClear();

      mgr.update(baseState({ backendState: "Stopped" }));
      expect(setIconSpy).toHaveBeenCalled();
    });
  });

  describe("icon fallback", () => {
    it("falls back to offline icons if warning icon fails", async () => {
      const mgr = new BadgeManager();
      setIconSpy.mockRejectedValueOnce(new Error("icon not found"));

      mgr.update(baseState({ installError: true }));

      // Let the rejection handler run
      await vi.waitFor(() => {
        expect(setIconSpy).toHaveBeenCalledTimes(2);
      });

      // Second call should use offline icons as fallback
      expect(setIconSpy).toHaveBeenLastCalledWith({
        path: expect.objectContaining({ 16: "icons/icon-16-offline.png" }),
      });
    });
  });
});
