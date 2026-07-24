// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseState } from "../../__test__/fixtures";
import { sendMessage } from "../popup";
import { renderConnected, updateConnected } from "./connected";

vi.mock("../popup", () => ({
  sendMessage: vi.fn(),
  enterSubView: vi.fn(),
  leaveSubView: vi.fn(),
  getLatestState: vi.fn(),
}));

describe("connected view", () => {
  beforeEach(() => {
    vi.mocked(sendMessage).mockClear();
  });

  it("renders Exit Node and Profile navigation as native buttons", () => {
    const root = document.createElement("div");
    renderConnected(
      root,
      baseState({
        currentProfile: { id: "work", name: "Work" },
        profiles: [{ id: "work", name: "Work" }],
      }),
    );

    const buttons = Array.from(root.querySelectorAll("button.setting-row"));
    expect(buttons.some((button) => button.textContent?.includes("Exit Node"))).toBe(
      true,
    );
    expect(buttons.some((button) => button.textContent?.includes("Profile"))).toBe(
      true,
    );
  });

  it("preserves focused split-tunneling edits across status updates", () => {
    const root = document.createElement("div");
    const state = baseState({
      domainSplit: { mode: "bypass", domains: ["saved.example.com"] },
    });
    renderConnected(root, state);
    const input = root.querySelector<HTMLTextAreaElement>(
      ".split-tunneling-input",
    )!;
    input.value = "unsaved.example.com";
    input.dispatchEvent(new Event("input"));
    input.focus();

    updateConnected(root, {
      ...state,
      stateVersion: 1,
      domainSplit: { mode: "only", domains: ["server.example.com"] },
    });

    expect(input.value).toBe("unsaved.example.com");
  });

  it("commits unsaved split-tunneling domains when the mode changes", () => {
    const root = document.createElement("div");
    renderConnected(
      root,
      baseState({ domainSplit: { mode: "bypass", domains: [] } }),
    );
    const input = root.querySelector<HTMLTextAreaElement>(
      ".split-tunneling-input",
    )!;
    input.value = "internal.example.com\n***";
    input.dispatchEvent(new Event("input"));

    root
      .querySelector<HTMLButtonElement>(
        '.split-tunneling-mode-btn[data-mode="only"]',
      )!
      .click();

    expect(sendMessage).toHaveBeenCalledWith({
      type: "set-domain-split",
      config: { mode: "only", domains: ["internal.example.com"] },
    });
  });
});
