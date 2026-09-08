// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { baseState } from "../../__test__/fixtures";
import { policyFromState } from "../../background/routing-protection";
import { renderNeedsLogin } from "./needs-login";
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
