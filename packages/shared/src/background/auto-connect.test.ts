import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BackendState } from "../types";
import {
  AUTO_CONNECT_PREF_KEY,
  isAutoConnectHandled,
  markAutoConnectHandled,
  readAutoConnectPref,
  shouldAutoConnect,
  writeAutoConnectPref,
} from "./auto-connect";

type GetFn = (key: string) => Promise<Record<string, unknown>>;
type SetFn = (items: Record<string, unknown>) => Promise<void>;

// Treat `chrome.storage.session` as optional so the tests can swap it for a
// stub or remove it entirely (to exercise the missing-API fallback path).
type StorageWithSession = Omit<typeof chrome.storage, "session"> & {
  session?: { get: GetFn; set: SetFn };
};
const storage = chrome.storage as unknown as StorageWithSession;

describe("shouldAutoConnect", () => {
  const cases: Array<[BackendState, boolean]> = [
    ["NoState", true],
    ["Stopped", true],
    ["Starting", false],
    ["Running", false],
    ["NeedsLogin", false],
    ["NeedsMachineAuth", false],
    ["InUseOtherUser", false],
  ];

  for (const [state, expected] of cases) {
    it(`returns ${expected} for ${state}`, () => {
      expect(shouldAutoConnect(state)).toBe(expected);
    });
  }
});

describe("autoConnectOnStart preference (storage.local)", () => {
  beforeEach(() => {
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      () => Promise.resolve({}),
    );
    (chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      () => Promise.resolve(),
    );
  });

  it("defaults to false when nothing is stored", async () => {
    expect(await readAutoConnectPref()).toBe(false);
  });

  it("returns true when storage has the flag set", async () => {
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      () => Promise.resolve({ [AUTO_CONNECT_PREF_KEY]: true }),
    );
    expect(await readAutoConnectPref()).toBe(true);
  });

  it("returns false for non-boolean stored values", async () => {
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      () => Promise.resolve({ [AUTO_CONNECT_PREF_KEY]: "yes" }),
    );
    expect(await readAutoConnectPref()).toBe(false);
  });

  it("persists writes to storage.local", async () => {
    const setSpy = vi.fn(() => Promise.resolve());
    (chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>) = setSpy;
    await writeAutoConnectPref(true);
    expect(setSpy).toHaveBeenCalledWith({ [AUTO_CONNECT_PREF_KEY]: true });
    await writeAutoConnectPref(false);
    expect(setSpy).toHaveBeenCalledWith({ [AUTO_CONNECT_PREF_KEY]: false });
  });
});

describe("auto-connect session flag (storage.session)", () => {
  let getSpy: ReturnType<typeof vi.fn>;
  let setSpy: ReturnType<typeof vi.fn>;
  let originalSession: { get: GetFn; set: SetFn } | undefined;

  beforeEach(() => {
    originalSession = storage.session;
    getSpy = vi.fn(((_key: string) => Promise.resolve({})) as GetFn);
    setSpy = vi.fn(((_items: Record<string, unknown>) => Promise.resolve()) as SetFn);
    storage.session = { get: getSpy as unknown as GetFn, set: setSpy as unknown as SetFn };
  });

  afterEach(() => {
    storage.session = originalSession;
  });

  it("isAutoConnectHandled returns false when session storage is empty", async () => {
    expect(await isAutoConnectHandled()).toBe(false);
  });

  it("isAutoConnectHandled returns true when the flag is set", async () => {
    getSpy.mockResolvedValueOnce({ autoConnectHandled: true });
    expect(await isAutoConnectHandled()).toBe(true);
  });

  it("markAutoConnectHandled writes the flag to session storage", async () => {
    await markAutoConnectHandled();
    expect(setSpy).toHaveBeenCalledWith({ autoConnectHandled: true });
  });
});

describe("auto-connect session flag fallback (no chrome.storage.session)", () => {
  let originalSession: { get: GetFn; set: SetFn } | undefined;

  beforeEach(() => {
    originalSession = storage.session;
    storage.session = undefined;
  });

  afterEach(() => {
    storage.session = originalSession;
  });

  it("isAutoConnectHandled returns false when session API is unavailable", async () => {
    expect(await isAutoConnectHandled()).toBe(false);
  });

  it("markAutoConnectHandled is a no-op when session API is unavailable", async () => {
    await expect(markAutoConnectHandled()).resolves.toBeUndefined();
  });
});
