// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeUiSurface } from "../../background/ui-surface";
import { renderUiSurfaceFooter, renderUiSurfaceRow } from "./ui-surface-row";

vi.mock("../../background/ui-surface", () => ({
  readUiSurface: vi.fn(() => Promise.resolve("popup" as const)),
  writeUiSurface: vi.fn(() => Promise.resolve()),
}));

describe("Open as side panel toggle", () => {
  beforeEach(() => {
    (writeUiSurface as ReturnType<typeof vi.fn>).mockClear();
  });

  it("renders the row with the label and an unchecked toggle when in popup mode", async () => {
    const container = document.createElement("div");
    await renderUiSurfaceRow(container);
    const label = container.querySelector(".setting-label");
    expect(label?.textContent).toBe("Open as side panel");
    const checkbox = container.querySelector("input[type='checkbox']") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it("calls writeUiSurface('sidePanel') when the toggle is flipped on", async () => {
    const container = document.createElement("div");
    await renderUiSurfaceRow(container);
    const checkbox = container.querySelector("input[type='checkbox']") as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    expect(writeUiSurface).toHaveBeenCalledWith("sidePanel");
  });

  it("footer wraps the row in a .ui-surface-footer container appended to the view", () => {
    const view = document.createElement("div");
    renderUiSurfaceFooter(view);
    const footer = view.querySelector(".ui-surface-footer");
    expect(footer).not.toBeNull();
    expect(footer?.parentElement).toBe(view);
  });
});
