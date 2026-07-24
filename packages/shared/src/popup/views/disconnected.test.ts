// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { baseState } from "../../__test__/fixtures";
import { renderDisconnected } from "./disconnected";

describe("disconnected view", () => {
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
});
