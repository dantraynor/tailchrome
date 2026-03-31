import { describe, it, expect, vi, afterEach } from "vitest";
import { detectPlatform } from "./utils";

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
