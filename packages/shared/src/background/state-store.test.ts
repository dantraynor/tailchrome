import { describe, it, expect, vi } from "vitest";
import { StateStore } from "./state-store";
import type { StatusUpdate } from "../types";

describe("StateStore", () => {
  describe("initial state", () => {
    it("starts disconnected and uninitialized", () => {
      const store = new StateStore();
      const state = store.getState();
      expect(state.hostConnected).toBe(false);
      expect(state.initialized).toBe(false);
      expect(state.backendState).toBe("NoState");
      expect(state.proxyPort).toBeNull();
      expect(state.peers).toEqual([]);
      expect(state.health).toEqual([]);
    });
  });

  describe("update", () => {
    it("merges partial state", () => {
      const store = new StateStore();
      store.update({ hostConnected: true, proxyPort: 1055 });
      const state = store.getState();
      expect(state.hostConnected).toBe(true);
      expect(state.proxyPort).toBe(1055);
      // Other fields unchanged
      expect(state.initialized).toBe(false);
      expect(state.backendState).toBe("NoState");
    });

    it("overwrites previous values", () => {
      const store = new StateStore();
      store.update({ proxyPort: 1055 });
      store.update({ proxyPort: 2080 });
      expect(store.getState().proxyPort).toBe(2080);
    });
  });

  describe("subscribe", () => {
    it("notifies listeners on update", () => {
      const store = new StateStore();
      const listener = vi.fn();
      store.subscribe(listener);
      store.update({ hostConnected: true });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ hostConnected: true })
      );
    });

    it("supports multiple listeners", () => {
      const store = new StateStore();
      const a = vi.fn();
      const b = vi.fn();
      store.subscribe(a);
      store.subscribe(b);
      store.update({ initialized: true });
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it("unsubscribes correctly", () => {
      const store = new StateStore();
      const listener = vi.fn();
      const unsub = store.subscribe(listener);
      unsub();
      store.update({ hostConnected: true });
      expect(listener).not.toHaveBeenCalled();
    });

    it("continues notifying other listeners when one throws", () => {
      const store = new StateStore();
      const bad = vi.fn(() => {
        throw new Error("boom");
      });
      const good = vi.fn();
      store.subscribe(bad);
      store.subscribe(good);
      store.update({ hostConnected: true });
      expect(bad).toHaveBeenCalled();
      expect(good).toHaveBeenCalled();
    });
  });

  describe("applyStatusUpdate", () => {
    it("maps status fields to state", () => {
      const store = new StateStore();
      const status: StatusUpdate = {
        backendState: "Running",
        running: true,
        tailnet: "my-tailnet",
        magicDNSSuffix: "my-tailnet.ts.net",
        selfNode: {
          id: "self1",
          hostname: "my-machine",
          dnsName: "my-machine.my-tailnet.ts.net.",
          tailscaleIPs: ["100.64.0.1"],
          os: "linux",
          online: true,
          keyExpiry: null,
        },
        needsLogin: false,
        browseToURL: "",
        exitNode: null,
        peers: [],
        prefs: null,
        health: [],
        error: null,
      };

      store.applyStatusUpdate(status);
      const state = store.getState();
      expect(state.backendState).toBe("Running");
      expect(state.tailnet).toBe("my-tailnet");
      expect(state.magicDNSSuffix).toBe("my-tailnet.ts.net");
      expect(state.selfNode?.hostname).toBe("my-machine");
    });

    it("defaults missing arrays on selfNode", () => {
      const store = new StateStore();
      const status: StatusUpdate = {
        backendState: "Running",
        running: true,
        tailnet: "t",
        magicDNSSuffix: "",
        selfNode: {
          id: "s",
          hostname: "h",
          dnsName: "d",
          tailscaleIPs: undefined as unknown as string[],
          os: "linux",
          online: true,
          keyExpiry: null,
        },
        needsLogin: false,
        browseToURL: "",
        exitNode: null,
        peers: [],
        prefs: null,
        health: [],
        error: null,
      };

      store.applyStatusUpdate(status);
      expect(store.getState().selfNode?.tailscaleIPs).toEqual([]);
    });

    it("defaults missing arrays on peers", () => {
      const store = new StateStore();
      const status: StatusUpdate = {
        backendState: "Running",
        running: true,
        tailnet: "t",
        magicDNSSuffix: "",
        selfNode: null,
        needsLogin: false,
        browseToURL: "",
        exitNode: null,
        peers: [
          {
            id: "p1",
            hostname: "peer",
            dnsName: "peer.ts.net.",
            tailscaleIPs: undefined as unknown as string[],
            os: "linux",
            online: true,
            active: true,
            exitNode: false,
            exitNodeOption: false,
            isSubnetRouter: false,
            subnets: undefined as unknown as string[],
            tags: undefined as unknown as string[],
            rxBytes: 0,
            txBytes: 0,
            lastSeen: null,
            lastHandshake: null,
            keyExpiry: null,
            location: null,
            taildropTarget: false,
            sshHost: false,
            userId: 1,
            userName: "u",
            userLoginName: "u@e",
            userProfilePicURL: "",
          },
        ],
        prefs: null,
        health: [],
        error: null,
      };

      store.applyStatusUpdate(status);
      const peer = store.getState().peers[0]!;
      expect(peer.tailscaleIPs).toEqual([]);
      expect(peer.subnets).toEqual([]);
      expect(peer.tags).toEqual([]);
    });

    it("handles null peers array from native host", () => {
      const store = new StateStore();
      const status: StatusUpdate = {
        backendState: "Running",
        running: true,
        tailnet: "t",
        magicDNSSuffix: "",
        selfNode: null,
        needsLogin: false,
        browseToURL: "",
        exitNode: null,
        peers: undefined as unknown as [],
        prefs: null,
        health: undefined as unknown as string[],
        error: null,
      };

      store.applyStatusUpdate(status);
      expect(store.getState().peers).toEqual([]);
      expect(store.getState().health).toEqual([]);
    });

    it("notifies listeners after applying status", () => {
      const store = new StateStore();
      const listener = vi.fn();
      store.subscribe(listener);

      store.applyStatusUpdate({
        backendState: "NeedsLogin",
        running: false,
        tailnet: null,
        magicDNSSuffix: "",
        selfNode: null,
        needsLogin: true,
        browseToURL: "https://login.tailscale.com/...",
        exitNode: null,
        peers: [],
        prefs: null,
        health: [],
        error: null,
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ backendState: "NeedsLogin" })
      );
    });
  });
});
