// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { baseState } from "../../__test__/fixtures";
import { policyFromState } from "../../background/routing-protection";
import { renderNeedsLogin, updateNeedsLogin } from "./needs-login";
import { sendMessage } from "../popup";

vi.mock("../popup", () => ({ sendMessage: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe("login recovery", () => {
  it.each(["blocked", "active", "direct"] as const)("explains the login action with %s routing", (mode) => {
    const root = document.createElement("div");
    const state = baseState({ backendState: "NeedsLogin" });
    state.routingPolicy = { ...policyFromState(state), mode };
    renderNeedsLogin(root, state);
    const button = root.querySelector<HTMLButtonElement>(".btn-primary")!;
    expect(button.textContent).toBe(mode === "direct" ? "Log In" : "Disconnect and log in");
    button.click();
    expect(sendMessage).toHaveBeenCalledWith({ type: mode === "direct" ? "login" : "disconnect-and-login" });
  });
});

describe("auth key login", () => {
  it("sends a trimmed auth key once and clears the field", () => {
    const root = document.createElement("div");
    renderNeedsLogin(root, baseState({ backendState: "NeedsLogin", supportsAuthKeyLogin: true }));
    const input = root.querySelector<HTMLInputElement>(".auth-key-input")!;
    expect(input.type).toBe("password");
    input.value = "  tskey-auth-abc123  ";
    root.querySelector<HTMLFormElement>(".auth-key-form")!.dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    expect(sendMessage).toHaveBeenCalledWith({ type: "login-with-auth-key", authKey: "tskey-auth-abc123" });
    expect(input.value).toBe("");
  });

  it("ignores an empty key", () => {
    const root = document.createElement("div");
    renderNeedsLogin(root, baseState({ backendState: "NeedsLogin", supportsAuthKeyLogin: true }));
    root.querySelector<HTMLFormElement>(".auth-key-form")!.dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("asks older helpers to update", () => {
    const root = document.createElement("div");
    renderNeedsLogin(root, baseState({ backendState: "NeedsLogin", supportsAuthKeyLogin: false }));
    expect(root.querySelector<HTMLInputElement>(".auth-key-input")!.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>(".auth-key-submit")!.disabled).toBe(true);
    expect(root.querySelector(".auth-key-note")!.textContent).toContain("Update the native helper");
  });

  it("keeps a typed key across status re-renders", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const state = baseState({ backendState: "NeedsLogin", supportsAuthKeyLogin: true });
    renderNeedsLogin(root, state);
    root.querySelector<HTMLInputElement>(".auth-key-input")!.value = "tskey-auth-partial";
    updateNeedsLogin(root, state);
    expect(root.querySelector<HTMLInputElement>(".auth-key-input")!.value).toBe("tskey-auth-partial");
    root.remove();
  });
});
