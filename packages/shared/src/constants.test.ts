import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTROL_URL_ORIGINS,
  DEFAULT_LOGIN_ORIGINS,
  isCustomControlURL,
  isValidControlURL,
} from "./constants";

describe("isCustomControlURL", () => {
  it("treats empty and default Tailscale URLs as non-custom", () => {
    expect(isCustomControlURL(undefined)).toBe(false);
    expect(isCustomControlURL(null)).toBe(false);
    expect(isCustomControlURL("")).toBe(false);
    expect(isCustomControlURL("https://controlplane.tailscale.com")).toBe(false);
    expect(isCustomControlURL("https://login.tailscale.com")).toBe(false);
  });

  it("treats custom coordination server URLs as custom", () => {
    expect(isCustomControlURL("https://headscale.example.com")).toBe(true);
  });

  it("ignores invalid values", () => {
    expect(isCustomControlURL("not a url")).toBe(false);
  });
});

describe("default origin sets", () => {
  it("derives the login origins from the single control-origin source", () => {
    // DEFAULT_LOGIN_ORIGINS is a superset of the control-plane origins.
    for (const origin of DEFAULT_CONTROL_URL_ORIGINS) {
      expect(DEFAULT_LOGIN_ORIGINS).toContain(origin);
    }
    expect(DEFAULT_LOGIN_ORIGINS).toContain("https://tailscale.com");
  });
});

describe("isValidControlURL", () => {
  it("accepts well-formed http and https URLs", () => {
    expect(isValidControlURL("https://headscale.example.com")).toBe(true);
    expect(isValidControlURL("http://headscale.test:8080")).toBe(true);
  });

  it("rejects malformed values and non-http(s) schemes", () => {
    expect(isValidControlURL("not a url")).toBe(false);
    expect(isValidControlURL("ftp://example.com")).toBe(false);
    expect(isValidControlURL("https://")).toBe(false);
    expect(isValidControlURL("example.com")).toBe(false);
  });
});
