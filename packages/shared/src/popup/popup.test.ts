// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import {
  enterSubView,
  leaveSubView,
  render,
  viewForState,
} from "./popup";
import { baseState } from "../__test__/fixtures";

describe("viewForState", () => {
  it("returns 'connected' when backendState is Running", () => {
    expect(viewForState(baseState({ backendState: "Running" }))).toBe("connected");
  });

  it("returns 'needs-login' when backendState is NeedsLogin", () => {
    expect(viewForState(baseState({ backendState: "NeedsLogin" }))).toBe(
      "needs-login"
    );
  });

  it("returns 'disconnected' when backendState is Stopped", () => {
    expect(viewForState(baseState({ backendState: "Stopped" }))).toBe(
      "disconnected"
    );
  });

  it("returns 'disconnected' when backendState is Starting", () => {
    expect(viewForState(baseState({ backendState: "Starting" }))).toBe(
      "disconnected"
    );
  });

  it("returns 'needs-install' when installError is true", () => {
    expect(viewForState(baseState({ installError: true }))).toBe("needs-install");
  });

  it("returns 'needs-update' when the helper version mismatches", () => {
    expect(viewForState(baseState({ hostVersionMismatch: true }))).toBe(
      "needs-update",
    );
  });

  it("needs-update takes precedence over NeedsLogin", () => {
    expect(
      viewForState(
        baseState({
          backendState: "NeedsLogin",
          hostVersionMismatch: true,
        }),
      ),
    ).toBe("needs-update");
  });

  it("installError takes precedence over Running backendState", () => {
    expect(
      viewForState(baseState({ installError: true, backendState: "Running" }))
    ).toBe("needs-install");
  });

  it("installError takes precedence over NeedsLogin", () => {
    expect(
      viewForState(baseState({ installError: true, backendState: "NeedsLogin" }))
    ).toBe("needs-install");
  });

  it("returns 'disconnected' for NoState backendState", () => {
    expect(viewForState(baseState({ backendState: "NoState" }))).toBe(
      "disconnected"
    );
  });

  it("returns 'disconnected' for NeedsMachineAuth backendState", () => {
    expect(viewForState(baseState({ backendState: "NeedsMachineAuth" }))).toBe(
      "disconnected"
    );
  });

  it("returns 'disconnected' for InUseOtherUser backendState", () => {
    expect(viewForState(baseState({ backendState: "InUseOtherUser" }))).toBe(
      "disconnected"
    );
  });
});

describe("sub-view state orchestration", () => {
  it("live-updates once per state version and renders the latest deferred state on exit", () => {
    document.body.innerHTML = '<div id="root"></div>';
    const initial = baseState({ stateVersion: 100, tailnet: "initial.ts.net" });
    render(initial);
    const updater = vi.fn();
    enterSubView(updater);

    const first = baseState({ stateVersion: 101, tailnet: "first.ts.net" });
    render(first);
    render({ ...first, tailnet: "same-version.ts.net" });
    const latest = baseState({ stateVersion: 102, tailnet: "latest.ts.net" });
    render(latest);

    expect(updater).toHaveBeenCalledTimes(2);
    expect(document.getElementById("root")?.textContent).toContain(
      "initial.ts.net",
    );

    leaveSubView();
    expect(document.getElementById("root")?.textContent).toContain(
      "latest.ts.net",
    );
  });
});
