import { describe, it, expect, vi, afterEach } from "vitest";
import { detectPlatform, formatBytes, formatKeyExpiryLocal } from "./utils";

describe("detectPlatform", () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    // Restore original navigator
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  });

  function mockNavigator(platform: string, userAgentData?: { platform: string }) {
    Object.defineProperty(globalThis, "navigator", {
      value: {
        platform,
        ...(userAgentData ? { userAgentData } : {}),
      },
      writable: true,
      configurable: true,
    });
  }

  it("detects macOS from navigator.platform", () => {
    mockNavigator("MacIntel");
    expect(detectPlatform()).toBe("macos");
  });

  it("detects macOS from userAgentData", () => {
    mockNavigator("", { platform: "macOS" });
    expect(detectPlatform()).toBe("macos");
  });

  it("detects Windows", () => {
    mockNavigator("Win32");
    expect(detectPlatform()).toBe("windows");
  });

  it("detects Linux", () => {
    mockNavigator("Linux x86_64");
    expect(detectPlatform()).toBe("linux");
  });

  it("returns unknown for unrecognized platform", () => {
    mockNavigator("FreeBSD");
    expect(detectPlatform()).toBe("unknown");
  });
});

describe("formatBytes", () => {
  it("formats zero bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats bytes below 1 KB", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats small KB with one decimal", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("formats larger KB as integer", () => {
    expect(formatBytes(102400)).toBe("100 KB");
  });

  it("formats MB", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("formats GB", () => {
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });
});

describe("formatKeyExpiryLocal", () => {
  it("returns empty string for null", () => {
    expect(formatKeyExpiryLocal(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(formatKeyExpiryLocal(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(formatKeyExpiryLocal("")).toBe("");
  });

  it("returns raw value for unparseable date", () => {
    expect(formatKeyExpiryLocal("not-a-date")).toBe("not-a-date");
  });

  it("returns a locale string for valid ISO date", () => {
    const result = formatKeyExpiryLocal("2025-12-31T23:59:59Z");
    expect(result).toBeTruthy();
    expect(result).not.toBe("2025-12-31T23:59:59Z");
  });
});
