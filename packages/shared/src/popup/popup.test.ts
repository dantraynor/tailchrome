import { describe, it, expect } from "vitest";
import { viewForState } from "./popup";
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
});
