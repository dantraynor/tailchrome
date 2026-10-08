// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseState, makePeer } from "../../__test__/fixtures";
import type { RoutingHealth } from "../../types";
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

  it.each<RoutingHealth["status"]>(["active", "blocked", "conflicted", "unavailable", "inactive"])(
    "reflects browser routing health (%s) in the connection indicator",
    (status) => {
      const root = document.createElement("div");
      renderConnected(root, baseState({ routingHealth: { status: "active", message: "" } }));
      updateConnected(root, baseState({ routingHealth: { status, message: "Routing detail" } }));

      const expected = {
        active: ["active", "Browser routing active"],
        blocked: ["blocked", "Protected traffic blocked"],
        conflicted: ["warning", "Browser proxy controlled elsewhere"],
        unavailable: ["warning", "Browser routing unavailable"],
        inactive: ["inactive", "Browser routing off"],
      }[status];
      expect(root.querySelector<HTMLElement>(".status-bar")?.dataset.routing).toBe(expected[0]);
      expect(root.querySelector(".status-bar-routing")?.textContent).toBe(expected[1]);
      expect(root.querySelector(".status-bar-routing")?.getAttribute("title")).toBe("Routing detail");
    },
  );

  it("does not show working routing until browser confirmation arrives", () => {
    const root = document.createElement("div");
    renderConnected(root, baseState());
    expect(root.querySelector<HTMLElement>(".status-bar")?.dataset.routing).toBe("warning");
    expect(root.textContent).toContain("Checking browser routing");
  });

  it("explains when an unavailable exit node is blocking traffic", () => {
    const root = document.createElement("div");
    renderConnected(root, baseState({
      selectedExitNodeID: "missing-exit",
      routingHealth: { status: "blocked", message: "" },
    }));
    expect(root.querySelector(".status-bar-routing")?.textContent)
      .toBe("Exit node unavailable · traffic blocked");
  });

  it("counts only actual devices when deciding whether to show search", () => {
    const root = document.createElement("div");
    const peers = Array.from({ length: 8 }, (_, i) => makePeer({
      id: `mullvad-${i}`, tags: ["tag:mullvad-exit-node"],
    }));
    renderConnected(root, baseState({ peers }));
    expect(root.querySelector(".peer-search")).toBeNull();
    expect(root.querySelector(".peer-list-toggle")).toBeNull();
  });

  const devicePeers = Array.from({ length: 8 }, (_, i) => makePeer({
    id: `device-${i}`,
    dnsName: `device-${i}.example.ts.net.`,
  }));

  it("keeps View all selected when profile data triggers a full redraw", () => {
    const root = document.createElement("div");
    const state = baseState({ peers: devicePeers });
    renderConnected(root, state);
    root.querySelector<HTMLButtonElement>(".peer-list-toggle")!.click();
    const originalContainer = root.querySelector(".peer-container");

    updateConnected(root, {
      ...state,
      currentProfile: { id: "work", name: "Work" },
      profiles: [{ id: "work", name: "Work" }],
    });

    expect(root.querySelector(".peer-container")).not.toBe(originalContainer);
    expect(root.querySelectorAll(".peer-item")).toHaveLength(8);
    expect(root.querySelector(".peer-list-toggle")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("retains the expansion preference across search-threshold redraws", () => {
    const root = document.createElement("div");
    const state = baseState({ peers: devicePeers });
    renderConnected(root, state);
    root.querySelector<HTMLButtonElement>(".peer-list-toggle")!.click();

    updateConnected(root, { ...state, peers: devicePeers.slice(0, 5) });
    expect(root.querySelector(".peer-search")).toBeNull();
    updateConnected(root, state);
    expect(root.querySelectorAll(".peer-item")).toHaveLength(8);

    root.querySelector<HTMLButtonElement>(".peer-list-toggle")!.click();
    renderConnected(root, state);
    expect(root.querySelectorAll(".peer-item")).toHaveLength(5);
  });

  it("keeps View all when returning to the dashboard without sharing it between roots", () => {
    const root = document.createElement("div");
    const state = baseState({ peers: devicePeers });
    renderConnected(root, state);
    root.querySelector<HTMLButtonElement>(".peer-list-toggle")!.click();
    root.textContent = "Another view";

    const otherRoot = document.createElement("div");
    renderConnected(otherRoot, state);
    expect(otherRoot.querySelectorAll(".peer-item")).toHaveLength(5);

    renderConnected(root, state);
    expect(root.querySelectorAll(".peer-item")).toHaveLength(8);
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

  it("replaces an empty pre-login profile with the authenticated account", () => {
    const root = document.createElement("div");
    const pending = baseState({
      currentProfile: { id: "", name: "" },
      profiles: [{ id: "personal", name: "Personal" }],
    });
    renderConnected(root, pending);

    expect(
      root.querySelector(".setting-value-profile")?.textContent,
    ).toContain("Default");

    updateConnected(root, {
      ...pending,
      currentProfile: { id: "work", name: "Work" },
      profiles: [
        { id: "personal", name: "Personal" },
        { id: "work", name: "Work" },
      ],
    });

    expect(
      root.querySelector(".setting-value-profile")?.textContent,
    ).toContain("Work");
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
