import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadCustomUrls,
  getCustomUrl,
  setCustomUrl,
  clearCustomUrl,
  resolveOpenUrl,
} from "./custom-urls";

// --- resolveOpenUrl (pure function) ---

describe("resolveOpenUrl", () => {
  it("returns http://{host}/ when no custom value", () => {
    expect(resolveOpenUrl("my-server.ts.net")).toBe("http://my-server.ts.net/");
  });

  it("returns http://{host}/ when custom value is undefined", () => {
    expect(resolveOpenUrl("10.0.0.1", undefined)).toBe("http://10.0.0.1/");
  });

  it("returns http://{host}/ when custom value is empty string", () => {
    expect(resolveOpenUrl("10.0.0.1", "")).toBe("http://10.0.0.1/");
  });

  it("appends numeric port to host", () => {
    expect(resolveOpenUrl("my-server.ts.net", "8080")).toBe(
      "http://my-server.ts.net:8080/"
    );
  });

  it("treats single digit as port", () => {
    expect(resolveOpenUrl("host", "3")).toBe("http://host:3/");
  });

  it("returns full URL with {host} placeholder replaced", () => {
    expect(resolveOpenUrl("my-server.ts.net", "https://{host}:8443/admin")).toBe(
      "https://my-server.ts.net:8443/admin"
    );
  });

  it("replaces multiple {host} placeholders", () => {
    expect(
      resolveOpenUrl("box", "https://{host}/api?redirect=http://{host}/done")
    ).toBe("https://box/api?redirect=http://box/done");
  });

  it("returns full URL as-is when no {host} placeholder", () => {
    expect(resolveOpenUrl("ignored", "https://custom.example.com/path")).toBe(
      "https://custom.example.com/path"
    );
  });

  it("rejects non-http custom URL and falls back to default", () => {
    expect(resolveOpenUrl("host", "abc")).toBe("http://host/");
  });

  it("rejects mixed string custom URL and falls back to default", () => {
    expect(resolveOpenUrl("host", "80abc")).toBe("http://host/");
  });
});

// --- Storage-backed functions ---

describe("custom URL storage", () => {
  let storage: Record<string, unknown>;

  beforeEach(() => {
    storage = {};
    vi.spyOn(chrome.storage.local, "get").mockImplementation((() =>
      Promise.resolve({ ...storage })
    ) as unknown as typeof chrome.storage.local.get);
    vi.spyOn(chrome.storage.local, "set").mockImplementation(((
      items: Record<string, unknown>,
    ) => {
      Object.assign(storage, items);
      return Promise.resolve();
    }) as unknown as typeof chrome.storage.local.set);
  });

  it("loadCustomUrls populates cache from storage", async () => {
    storage = { customUrls: { peer1: "8080", peer2: "https://example.com" } };
    await loadCustomUrls();
    expect(getCustomUrl("peer1")).toBe("8080");
    expect(getCustomUrl("peer2")).toBe("https://example.com");
  });

  it("loadCustomUrls returns empty object when nothing stored", async () => {
    const result = await loadCustomUrls();
    expect(result).toEqual({});
  });

  it("getCustomUrl returns undefined for unknown peer", async () => {
    await loadCustomUrls();
    expect(getCustomUrl("nonexistent")).toBeUndefined();
  });

  it("setCustomUrl persists to storage and updates cache", async () => {
    await loadCustomUrls();
    await setCustomUrl("peer1", "9090");
    expect(getCustomUrl("peer1")).toBe("9090");
    expect(storage["customUrls"]).toEqual({ peer1: "9090" });
  });

  it("clearCustomUrl removes from cache and storage", async () => {
    storage = { customUrls: { peer1: "8080" } };
    await loadCustomUrls();
    expect(getCustomUrl("peer1")).toBe("8080");

    await clearCustomUrl("peer1");
    expect(getCustomUrl("peer1")).toBeUndefined();
    expect(
      (storage["customUrls"] as Record<string, string>)["peer1"]
    ).toBeUndefined();
  });

  it("setCustomUrl then clearCustomUrl round-trips", async () => {
    await loadCustomUrls();
    await setCustomUrl("peer1", "443");
    expect(getCustomUrl("peer1")).toBe("443");
    await clearCustomUrl("peer1");
    expect(getCustomUrl("peer1")).toBeUndefined();
  });
});
