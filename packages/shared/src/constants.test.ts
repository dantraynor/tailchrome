import { describe, expect, it } from "vitest";
import { isCustomControlURL } from "./constants";

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
