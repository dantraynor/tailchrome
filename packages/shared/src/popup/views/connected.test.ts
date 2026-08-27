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

  it("summarises saved split-tunneling rules on the collapsed row", () => {
    const root = document.createElement("div");
    renderConnected(
      root,
      baseState({
        domainSplit: { mode: "only", domains: ["a.example.com", "b.example.com"] },
      }),
    );

    const header = root.querySelector<HTMLButtonElement>(
      ".split-tunneling-header",
    )!;
    const editor = root.querySelector<HTMLElement>(".split-tunneling-editor")!;

    // Collapsed by default, but the row still reports the live rule state.
    expect(editor.classList.contains("hidden")).toBe(true);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(
      header.querySelector(".setting-value-split-tunneling")!.firstChild!
        .textContent,
    ).toBe("Only · 2 domains");
  });

  it("reports no rules as Off, but never reports empty Only mode as Off", () => {
    const offRoot = document.createElement("div");
    renderConnected(
      offRoot,
      baseState({ domainSplit: { mode: "bypass", domains: [] } }),
    );
    expect(
      offRoot.querySelector(".setting-value-split-tunneling")!.firstChild!
        .textContent,
    ).toBe("Off");

    // "only" with an empty list routes nothing through the exit node — the
    // opposite of off — so it must not read as "Off".
    const onlyRoot = document.createElement("div");
    renderConnected(
      onlyRoot,
      baseState({ domainSplit: { mode: "only", domains: [] } }),
    );
    expect(
      onlyRoot.querySelector(".setting-value-split-tunneling")!.firstChild!
        .textContent,
    ).toBe("Only · no domains");
  });

  it("expands the split-tunneling editor when the row is clicked", () => {
    const root = document.createElement("div");
    renderConnected(root, baseState({}));

    const header = root.querySelector<HTMLButtonElement>(
      ".split-tunneling-header",
    )!;
    const editor = root.querySelector<HTMLElement>(".split-tunneling-editor")!;
    expect(header.getAttribute("aria-controls")).toBe(editor.id);

    header.click();
    expect(editor.classList.contains("hidden")).toBe(false);
    expect(header.getAttribute("aria-expanded")).toBe("true");

    header.click();
    expect(editor.classList.contains("hidden")).toBe(true);
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("refreshes the split-tunneling summary on save and on state updates", () => {
    const root = document.createElement("div");
    const state = baseState({ domainSplit: { mode: "bypass", domains: [] } });
    renderConnected(root, state);

    const summary = () =>
      root.querySelector(".setting-value-split-tunneling")!.firstChild!
        .textContent;
    expect(summary()).toBe("Off");

    const input = root.querySelector<HTMLTextAreaElement>(
      ".split-tunneling-input",
    )!;
    input.value = "saved.example.com";
    input.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".split-tunneling-save")!.click();

    // Optimistic: the summary updates without waiting for the background.
    expect(summary()).toBe("Bypass · 1 domain");

    updateConnected(root, {
      ...state,
      stateVersion: 1,
      domainSplit: { mode: "only", domains: ["a.example.com", "b.example.com"] },
    });
    expect(summary()).toBe("Only · 2 domains");
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
