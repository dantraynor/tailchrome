// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createToggle } from "./toggle-switch";

describe("createToggle", () => {
  it("gives the checkbox an accessible name", () => {
    const toggle = createToggle(false, vi.fn(), "MagicDNS");
    expect(toggle.querySelector("input")?.getAttribute("aria-label")).toBe(
      "MagicDNS",
    );
  });
});
