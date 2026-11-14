// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { baseState } from "../../__test__/fixtures";
import { policyFromState } from "../../background/routing-protection";
import { renderNeedsLogin, updateNeedsLogin } from "./needs-login";
import { resetAuthKeyLoginForTest } from "../components/auth-key-login";
import { sendMessage } from "../popup";

vi.mock("../popup", () => ({ sendMessage: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  resetAuthKeyLoginForTest();
});

describe("auth key sign-in", () => {
  const key = "tskey-auth-kExample-0123456789";

  function render(supportsAuthKeyLogin: boolean, mode: "blocked" | "direct" = "direct") {
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const state = baseState({ backendState: "NeedsLogin", supportsAuthKeyLogin });
    state.routingPolicy = { ...policyFromState(state), mode };
    renderNeedsLogin(root, state);
    return { root, state };
  }

  it("is hidden when the helper cannot take a key", () => {
    const { root } = render(false);
    expect(root.querySelector(".auth-key-login")).toBeNull();
  });

  it("starts collapsed and opens on request", () => {
    const { root } = render(true);
    const form = root.querySelector<HTMLFormElement>(".auth-key-form")!;
    const toggle = root.querySelector<HTMLButtonElement>(".auth-key-toggle")!;
    expect(form.hidden).toBe(true);
    toggle.click();
    expect(form.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector<HTMLInputElement>(".auth-key-input")!.type).toBe("password");
  });

  it.each(["direct", "blocked"] as const)("submits the key and clears the field with %s routing", (mode) => {
    const { root } = render(true, mode);
    root.querySelector<HTMLButtonElement>(".auth-key-toggle")!.click();
    const input = root.querySelector<HTMLInputElement>(".auth-key-input")!;
    input.value = `  ${key} `;
    root.querySelector<HTMLFormElement>(".auth-key-form")!.requestSubmit();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: "login-auth-key", authKey: key });
    expect(input.value).toBe("");
  });

  it("rejects an empty or spaced key inline", () => {
    const { root } = render(true);
    root.querySelector<HTMLButtonElement>(".auth-key-toggle")!.click();
    const input = root.querySelector<HTMLInputElement>(".auth-key-input")!;
    const form = root.querySelector<HTMLFormElement>(".auth-key-form")!;
    form.requestSubmit();
    input.value = "tskey one two";
    form.requestSubmit();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLElement>(".coordination-server-error:not([hidden])")).not.toBeNull();
  });

  it("keeps a pasted key and open form across status updates", () => {
    const { root, state } = render(true);
    root.querySelector<HTMLButtonElement>(".auth-key-toggle")!.click();
    const input = root.querySelector<HTMLInputElement>(".auth-key-input")!;
    input.value = key;
    input.focus();
    updateNeedsLogin(root, { ...state });
    const next = root.querySelector<HTMLInputElement>(".auth-key-input")!;
    expect(next).not.toBe(input);
    expect(next.value).toBe(key);
    expect(document.activeElement).toBe(next);
    expect(root.querySelector<HTMLFormElement>(".auth-key-form")!.hidden).toBe(false);
  });
});

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
