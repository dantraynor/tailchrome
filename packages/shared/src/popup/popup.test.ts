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

  it.each([
    "helper-unavailable",
    "helper-not-allowed",
    "helper-incompatible",
  ] as const)("routes %s to package or registration recovery", (kind) => {
    expect(
      viewForState(
        baseState({
          helperFailure: {
            kind,
            diagnosticCode: "fixture-failure",
            diagnosticMessage: null,
          },
        }),
      ),
    ).toBe("needs-install");
  });

  it.each([
    "helper-start-failed",
    "helper-stopped",
    "helper-reported-error",
  ] as const)("keeps %s recovery in the disconnected view", (kind) => {
    expect(
      viewForState(
        baseState({
          hostConnected: false,
          backendState: "NoState",
          helperFailure: {
            kind,
            diagnosticCode: "fixture-failure",
            diagnosticMessage: null,
          },
        }),
      ),
    ).toBe("disconnected");
  });

  it("a version notice never replaces the normal running view", () => {
    expect(
      viewForState(
        baseState({
          helperVersionNotice: {
            installedVersion: "0.1.11",
            releaseVersion: "0.1.12",
            relation: "older",
          },
        }),
      ),
    ).toBe("connected");
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

describe("non-blocking helper version notice", () => {
  it("renders above the normal view and can be dismissed for the popup session", () => {
    document.body.innerHTML = '<div id="root"></div>';
    render(
      baseState({
        stateVersion: 200,
        helperVersionNotice: {
          installedVersion: "0.1.11",
          releaseVersion: "0.1.12",
          relation: "older",
        },
      }),
    );

    const root = document.getElementById("root")!;
    expect(root.textContent).toContain(
      "Helper 0.1.11 is older than companion release 0.1.12.",
    );
    expect(root.textContent).toContain("example.ts.net");

    root.querySelector<HTMLButtonElement>(".helper-version-dismiss")!.click();
    render(
      baseState({
        stateVersion: 201,
        helperVersionNotice: {
          installedVersion: "0.1.11",
          releaseVersion: "0.1.12",
          relation: "older",
        },
      }),
    );
    expect(root.querySelector(".helper-version-notice")).toBeNull();
  });
});
