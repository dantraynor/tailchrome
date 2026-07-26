// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseState } from "../../__test__/fixtures";
import { renderDisconnected } from "./disconnected";
import { sendMessage } from "../popup";

vi.mock("../popup", () => ({
  sendMessage: vi.fn(),
}));

describe("disconnected view", () => {
  beforeEach(() => {
    vi.mocked(sendMessage).mockClear();
  });

  it("shows reconnecting state before the install-error fallback", () => {
    const root = document.createElement("div");
    renderDisconnected(
      root,
      baseState({
        hostConnected: false,
        backendState: "NoState",
        reconnecting: true,
      }),
    );

    expect(root.textContent).toContain("Reconnecting");
    expect(root.querySelector(".spinner")).not.toBeNull();
  });

  it.each([
    [
      "helper-start-failed",
      "The browser found the helper, but it stopped before setup completed.",
    ],
    [
      "helper-stopped",
      "The helper stopped after connecting. Tailchrome is retrying.",
    ],
    [
      "helper-reported-error",
      "The helper started but reported a startup error.",
    ],
  ] as const)("renders safe category copy for %s", (kind, expectedCopy) => {
    const root = document.createElement("div");
    renderDisconnected(
      root,
      baseState({
        hostConnected: false,
        backendState: "NoState",
        reconnecting: kind !== "helper-reported-error",
        helperFailure: {
          kind,
          diagnosticCode: "fixture-native-failure",
          diagnosticMessage:
            "raw fixture at /Users/alice/private https://auth.example.test",
        },
      }),
    );

    expect(root.textContent).toContain(expectedCopy);
    expect(root.textContent).not.toContain("raw fixture");
    expect(root.textContent).not.toContain("/Users/alice");
    expect(root.textContent).not.toContain("auth.example");
    expect(root.textContent).toContain("Copy diagnostic report");
    expect(root.textContent).toContain("Export diagnostic report");
  });

  it("sends a manual native-host retry from Retry Connection", () => {
    const root = document.createElement("div");
    renderDisconnected(
      root,
      baseState({
        hostConnected: false,
        backendState: "NoState",
        helperFailure: {
          kind: "helper-start-failed",
          diagnosticCode: "native-host-start-failed",
          diagnosticMessage: null,
        },
      }),
    );

    root.querySelector<HTMLButtonElement>(".btn-retry")!.click();

    expect(sendMessage).toHaveBeenCalledWith({
      type: "retry-native-host",
      source: "manual",
    });
    expect(sendMessage).not.toHaveBeenCalledWith({ type: "toggle" });
  });
});
