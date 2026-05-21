import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DEFAULT_DOMAIN_SPLIT,
  DOMAIN_SPLIT_STORAGE_KEY,
  defaultDomainSplit,
  normalizeDomainSplit,
  readDomainSplit,
  writeDomainSplit,
} from "./domain-split";
import { sanitizeDomain } from "./proxy-utils";

describe("sanitizeDomain", () => {
  it("lowercases and trims", () => {
    expect(sanitizeDomain("  Teams.Microsoft.COM  ")).toBe("teams.microsoft.com");
  });

  it("strips scheme, path, and port", () => {
    expect(sanitizeDomain("https://teams.microsoft.com/login?x=1")).toBe(
      "teams.microsoft.com",
    );
    expect(sanitizeDomain("http://example.com:8080/foo")).toBe("example.com");
  });

  it("strips a leading or trailing dot", () => {
    expect(sanitizeDomain(".microsoft.com")).toBe("microsoft.com");
    expect(sanitizeDomain("microsoft.com.")).toBe("microsoft.com");
  });

  it("rejects empty input", () => {
    expect(sanitizeDomain("")).toBeNull();
    expect(sanitizeDomain("   ")).toBeNull();
    expect(sanitizeDomain(null)).toBeNull();
    expect(sanitizeDomain(undefined)).toBeNull();
  });

  it("rejects unsafe characters (PAC injection)", () => {
    expect(sanitizeDomain('evil"); alert("xss')).toBeNull();
    expect(sanitizeDomain("foo.com\nbar.com")).toBeNull();
    expect(sanitizeDomain("foo bar.com")).toBeNull();
    expect(sanitizeDomain("foo$bar.com")).toBeNull();
  });

  it("rejects empty labels", () => {
    expect(sanitizeDomain("foo..bar")).toBeNull();
  });
});

describe("normalizeDomainSplit", () => {
  it("returns defaults for nullish or non-object input", () => {
    expect(normalizeDomainSplit(null)).toEqual(DEFAULT_DOMAIN_SPLIT);
    expect(normalizeDomainSplit(undefined)).toEqual(DEFAULT_DOMAIN_SPLIT);
    expect(normalizeDomainSplit("nope")).toEqual(DEFAULT_DOMAIN_SPLIT);
  });

  it("defaults invalid modes to bypass", () => {
    expect(normalizeDomainSplit({ mode: "whatever", domains: [] }).mode).toBe(
      "bypass",
    );
  });

  it("preserves valid modes", () => {
    expect(normalizeDomainSplit({ mode: "only", domains: [] }).mode).toBe("only");
  });

  it("drops invalid domains and deduplicates", () => {
    const result = normalizeDomainSplit({
      mode: "bypass",
      domains: [
        "teams.microsoft.com",
        "TEAMS.microsoft.com",
        '"evil',
        "",
        42 as unknown as string,
        "outlook.office.com",
      ],
    });
    expect(result.domains).toEqual([
      "teams.microsoft.com",
      "outlook.office.com",
    ]);
  });

  it("returns a fresh array on default", () => {
    const a = defaultDomainSplit();
    const b = defaultDomainSplit();
    expect(a).not.toBe(b);
    expect(a.domains).not.toBe(b.domains);
  });
});

describe("readDomainSplit / writeDomainSplit", () => {
  beforeEach(() => {
    const store: Record<string, unknown> = {};
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) =>
            key in store ? { [key]: store[key] } : {},
          ),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(store, items);
          }),
        },
      },
    } as unknown as typeof chrome;
  });

  it("returns defaults when storage is empty", async () => {
    expect(await readDomainSplit()).toEqual(DEFAULT_DOMAIN_SPLIT);
  });

  it("writes and reads round-trip", async () => {
    await writeDomainSplit({
      mode: "only",
      domains: ["teams.microsoft.com", "outlook.office.com"],
    });
    expect(await readDomainSplit()).toEqual({
      mode: "only",
      domains: ["teams.microsoft.com", "outlook.office.com"],
    });
  });

  it("normalizes on write (drops invalid, lowercases)", async () => {
    await writeDomainSplit({
      mode: "bypass",
      domains: ["Teams.Microsoft.COM", '"bad', ""],
    });
    const setSpy = chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>;
    expect(setSpy).toHaveBeenCalledWith({
      [DOMAIN_SPLIT_STORAGE_KEY]: {
        mode: "bypass",
        domains: ["teams.microsoft.com"],
      },
    });
  });

  it("returns defaults if storage throws", async () => {
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      () => Promise.reject(new Error("boom")),
    );
    expect(await readDomainSplit()).toEqual(DEFAULT_DOMAIN_SPLIT);
  });
});
