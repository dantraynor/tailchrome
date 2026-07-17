import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BackendState } from "../types";
import {
  AUTO_CONNECT_PREF_KEY,
  isAutoConnectHandled,
  markAutoConnectHandled,
  readAutoConnectPref,
  readSessionIntent,
  resolveStartupWantRunning,
  shouldAutoConnect,
  writeAutoConnectPref,
  writeSessionIntent,
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

describe("session intent (storage.session)", () => {
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

  it("round-trips a value written with writeSessionIntent", async () => {
    await writeSessionIntent(true);
    expect(setSpy).toHaveBeenCalledWith({ desiredWantRunning: true });

    getSpy.mockResolvedValueOnce({ desiredWantRunning: true });
    expect(await readSessionIntent()).toBe(true);

    await writeSessionIntent(false);
    expect(setSpy).toHaveBeenCalledWith({ desiredWantRunning: false });

    getSpy.mockResolvedValueOnce({ desiredWantRunning: false });
    expect(await readSessionIntent()).toBe(false);
  });

  it("readSessionIntent returns undefined when the key is missing", async () => {
    expect(await readSessionIntent()).toBeUndefined();
  });

  it("readSessionIntent returns undefined for non-boolean stored values", async () => {
    getSpy.mockResolvedValueOnce({ desiredWantRunning: "yes" });
    expect(await readSessionIntent()).toBeUndefined();
  });
});

describe("session intent fallback (no chrome.storage.session)", () => {
  let originalSession: { get: GetFn; set: SetFn } | undefined;

  beforeEach(() => {
    originalSession = storage.session;
    storage.session = undefined;
  });

  afterEach(() => {
    storage.session = originalSession;
  });

  it("readSessionIntent returns undefined when session API is unavailable", async () => {
    expect(await readSessionIntent()).toBeUndefined();
  });

  it("writeSessionIntent is a no-op when session API is unavailable", async () => {
    await expect(writeSessionIntent(true)).resolves.toBeUndefined();
  });
});

describe("resolveStartupWantRunning", () => {
  let sessionGetSpy: ReturnType<typeof vi.fn>;
  let sessionSetSpy: ReturnType<typeof vi.fn>;
  let originalSession: { get: GetFn; set: SetFn } | undefined;

  beforeEach(() => {
    originalSession = storage.session;
    sessionGetSpy = vi.fn(((_key: string) => Promise.resolve({})) as GetFn);
    sessionSetSpy = vi.fn(((_items: Record<string, unknown>) => Promise.resolve()) as SetFn);
    storage.session = {
      get: sessionGetSpy as unknown as GetFn,
      set: sessionSetSpy as unknown as SetFn,
    };

    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      () => Promise.resolve({}),
    );
    (chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      () => Promise.resolve(),
    );
  });

  afterEach(() => {
    storage.session = originalSession;
  });

  it("returns the recorded session intent without touching the pref", async () => {
    sessionGetSpy.mockResolvedValueOnce({ desiredWantRunning: true });
    const localGetSpy = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>;

    expect(await resolveStartupWantRunning()).toBe(true);
    expect(localGetSpy).not.toHaveBeenCalled();
    expect(sessionSetSpy).not.toHaveBeenCalled();
  });

  it("falls back to the pref when there is no session intent, and records it", async () => {
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>) = vi.fn(() =>
      Promise.resolve({ [AUTO_CONNECT_PREF_KEY]: true }),
    );

    expect(await resolveStartupWantRunning()).toBe(true);
    expect(sessionSetSpy).toHaveBeenCalledWith({ desiredWantRunning: true });
  });

  it("returns false and records false when the pref is unset", async () => {
    expect(await resolveStartupWantRunning()).toBe(false);
    expect(sessionSetSpy).toHaveBeenCalledWith({ desiredWantRunning: false });
  });
});
