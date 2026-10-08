// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TailscaleState } from "../../types";
import { baseState } from "../../__test__/fixtures";
import { sendMessage } from "../popup";
import { renderProfiles } from "./profiles";

vi.mock("../popup", () => ({ sendMessage: vi.fn() }));

const personal = { id: "personal", name: "Personal" };
const work = { id: "work", name: "Work" };
const other = { id: "other", name: "Other" };

function profileState(overrides: Partial<TailscaleState> = {}): TailscaleState {
  return baseState({
    currentProfile: personal,
    profiles: [personal, work, other],
    ...overrides,
  });
}

function row(root: HTMLElement, id: string): HTMLElement {
  return root.querySelector<HTMLElement>(`[data-profile-id="${id}"]`)!;
}

function select(root: HTMLElement, id: string): HTMLButtonElement {
  return row(root, id).querySelector<HTMLButtonElement>(".profile-select-btn")!;
}

function deleteButton(root: HTMLElement, id: string): HTMLButtonElement {
  return row(root, id).querySelector<HTMLButtonElement>(".profile-delete-btn")!;
}

function addButton(root: HTMLElement): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(".profile-add-row button")!;
}

function status(root: HTMLElement): string {
  return root.querySelector("[role='status']")!.textContent!;
}

function expectActive(root: HTMLElement, id: string): void {
  expect(root.querySelectorAll(".profile-row--current")).toHaveLength(1);
  expect(row(root, id).classList.contains("profile-row--current")).toBe(true);
  expect(row(root, id).querySelector(".profile-badge")?.textContent).toBe("Active");
  expect(select(root, id).getAttribute("aria-pressed")).toBe("true");
  expect(row(root, id).querySelector(".exit-node-radio--selected")).not.toBeNull();
}

function expectPending(root: HTMLElement, id = "work"): void {
  expect(root.querySelectorAll(".spinner")).toHaveLength(1);
  expect(row(root, id).classList.contains("profile-row--pending")).toBe(true);
  expect(root.querySelector(".profile-list")?.getAttribute("aria-busy")).toBe("true");
  expect(status(root)).toContain("Waiting for the helper to confirm");
  for (const button of root.querySelectorAll<HTMLButtonElement>(".profile-list button, .profile-add-row button")) {
    expect(button.disabled).toBe(true);
  }
}

function expectSettled(root: HTMLElement): void {
  expect(root.querySelector(".spinner")).toBeNull();
  expect(root.querySelector(".profile-row--pending")).toBeNull();
  expect(root.querySelector(".profile-list")?.getAttribute("aria-busy")).toBe("false");
}

describe("profiles view", () => {
  let root: HTMLElement;
  let onBack = vi.fn<() => void>();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(sendMessage).mockReset();
    vi.stubGlobal("confirm", vi.fn(() => true));
    root = document.createElement("div");
    document.body.appendChild(root);
    onBack = vi.fn();
    renderProfiles(root, profileState(), onBack);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.textContent = "";
  });

  it("keeps the confirmed profile Active until asynchronous confirmation", () => {
    select(root, "work").click();

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: "switch-profile", profileID: "work" });
    expectActive(root, "personal");
    expect(select(root, "work").getAttribute("aria-pressed")).toBe("false");
    expect(row(root, "work").querySelector(".exit-node-radio--selected")).toBeNull();
    expect(row(root, "work").querySelector(".profile-badge")?.textContent).toBe("Switching…");
    expectPending(root);
    expect(onBack).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    renderProfiles(root, profileState({ currentProfile: work, stateVersion: 1 }), onBack);

    expectActive(root, "work");
    expectSettled(root);
    expect(status(root)).toBe("");
    expect(addButton(root).disabled).toBe(false);
    expect(select(root, "personal").disabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(20_000);
    expect(status(root)).toBe("");
  });

  it("persists pending across unrelated status updates without restarting its timeout", () => {
    select(root, "work").click();
    vi.advanceTimersByTime(19_000);
    renderProfiles(root, profileState({
      stateVersion: 12,
      health: ["An unrelated warning"],
      error: "Tailscale reported a problem.",
      helperDiagnostic: { diagnosticCode: "helper-status-error", diagnosticMessage: "status failed" },
    }), onBack);

    expectActive(root, "personal");
    expectPending(root);
    expect(sendMessage).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1_000);
    expectSettled(root);
    expectActive(root, "personal");
    expect(status(root)).toContain("did not confirm the profile switch within 20 seconds");
  });

  it.each([null, { id: "", name: "" }])("retains the last confirmed identity during an empty profile update: %s", (currentProfile) => {
    select(root, "work").click();
    renderProfiles(root, profileState({ currentProfile, backendState: "Starting" }), onBack);

    expectPending(root);
    expectActive(root, "personal");

    vi.advanceTimersByTime(20_000);
    expectActive(root, "personal");
  });

  it("allows retry after timeout and preserves the message through status updates", () => {
    select(root, "work").click();
    vi.advanceTimersByTime(20_000);

    expectSettled(root);
    expect(status(root)).toContain("select a profile to try again");
    expect(select(root, "work").disabled).toBe(false);
    expect(deleteButton(root, "work").disabled).toBe(false);
    expect(addButton(root).disabled).toBe(false);
    const message = status(root);
    renderProfiles(root, profileState({ stateVersion: 2 }), onBack);
    expect(status(root)).toBe(message);

    select(root, "work").click();
    expectPending(root);
    expect(status(root)).not.toContain("did not confirm");
    expect(sendMessage).toHaveBeenCalledTimes(2);
    renderProfiles(root, profileState({ currentProfile: work }), onBack);
    expectSettled(root);
    expectActive(root, "work");
    expect(status(root)).toBe("");
  });

  it("accepts a late confirmed profile after timeout", () => {
    select(root, "work").click();
    vi.advanceTimersByTime(20_000);
    renderProfiles(root, profileState({ currentProfile: work }), onBack);

    expectActive(root, "work");
    expect(status(root)).toBe("");
    expectSettled(root);
  });

  it("clears pending for a new switch command error and allows another attempt", () => {
    select(root, "work").click();
    const failedState = profileState({
      helperDiagnostic: { diagnosticCode: "helper-command-switch-profile-error", diagnosticMessage: "private helper detail" },
    });
    renderProfiles(root, failedState, onBack);

    expectSettled(root);
    expectActive(root, "personal");
    expect(status(root)).toContain("could not switch profiles");
    expect(root.textContent).not.toContain("private helper detail");
    expect(vi.getTimerCount()).toBe(0);

    select(root, "work").click();
    renderProfiles(root, { ...failedState, stateVersion: 2, helperDiagnostic: { ...failedState.helperDiagnostic! } }, onBack);
    expectPending(root);
    expect(sendMessage).toHaveBeenCalledTimes(2);

    renderProfiles(root, profileState({ helperDiagnostic: {
      diagnosticCode: "helper-command-switch-profile-error",
      diagnosticMessage: "a different command failure",
    } }), onBack);
    expectSettled(root);
    expect(status(root)).toContain("could not switch profiles");
  });

  it("ignores stale equivalent command errors and errors for other commands", () => {
    const staleDiagnostic = { diagnosticCode: "helper-command-switch-profile-error", diagnosticMessage: "old failure" };
    renderProfiles(root, profileState({ helperDiagnostic: staleDiagnostic }), onBack);
    select(root, "work").click();
    renderProfiles(root, profileState({ stateVersion: 1, helperDiagnostic: { ...staleDiagnostic } }), onBack);
    expectPending(root);

    renderProfiles(root, profileState({ helperDiagnostic: {
      diagnosticCode: "helper-command-delete-profile-error", diagnosticMessage: "unrelated failure",
    } }), onBack);
    expectPending(root);
  });

  it("recognizes an identical command error as new after the diagnostic was cleared", () => {
    const helperDiagnostic = { diagnosticCode: "helper-command-switch-profile-error", diagnosticMessage: "failure" };
    renderProfiles(root, profileState({ helperDiagnostic }), onBack);
    select(root, "work").click();
    renderProfiles(root, profileState(), onBack);
    expectPending(root);
    renderProfiles(root, profileState({ helperDiagnostic }), onBack);
    expectSettled(root);
  });

  it("clears pending on disconnect, blocks commands, and permits retry after reconnect", () => {
    select(root, "work").click();
    renderProfiles(root, profileState({ hostConnected: false, initialized: false, backendState: "NoState" }), onBack);

    expectSettled(root);
    expectActive(root, "personal");
    expect(status(root)).toContain("connection was lost");
    expect(vi.getTimerCount()).toBe(0);
    select(root, "other").dispatchEvent(new MouseEvent("click"));
    deleteButton(root, "work").dispatchEvent(new MouseEvent("click"));
    addButton(root).dispatchEvent(new MouseEvent("click"));
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();

    renderProfiles(root, profileState(), onBack);
    select(root, "work").click();
    expectPending(root);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("clears pending when the helper reports a connection failure", () => {
    select(root, "work").click();
    renderProfiles(root, profileState({ helperFailure: {
      kind: "helper-reported-error", diagnosticCode: "helper-init-error", diagnosticMessage: "detail",
    } }), onBack);

    expectSettled(root);
    expect(addButton(root).disabled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(status(root)).toContain("Reconnect");
  });

  it("prevents repeated and conflicting commands from new and stale controls", () => {
    const staleSwitch = select(root, "work");
    const staleOther = select(root, "other");
    const staleDelete = deleteButton(root, "other");
    const staleAdd = addButton(root);
    staleSwitch.click();
    staleSwitch.click();
    staleOther.click();
    staleDelete.click();
    staleAdd.click();
    // Dispatch directly as well: command guards must also reject synthetic events.
    select(root, "other").dispatchEvent(new MouseEvent("click"));
    deleteButton(root, "other").dispatchEvent(new MouseEvent("click"));
    addButton(root).dispatchEvent(new MouseEvent("click"));

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    expectPending(root);
  });

  it("does not issue commands for the current profile", () => {
    select(root, "personal").click();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteButton(root, "personal")).toBeNull();
  });

  it("clears the timer on Back and starts a clean session when reopened", () => {
    const staleSwitch = select(root, "other");
    select(root, "work").click();
    root.querySelector<HTMLButtonElement>(".exit-nodes-header button")!.click();

    expect(onBack).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    renderProfiles(root, profileState(), onBack);
    expectSettled(root);
    expect(status(root)).toBe("");
    staleSwitch.click();
    expect(sendMessage).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(20_000);
    expect(status(root)).toBe("");
    select(root, "other").click();
    expectPending(root, "other");
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("cleans stale pending state when another view replaced the root before reopening", () => {
    select(root, "work").click();
    root.textContent = "A different view";
    renderProfiles(root, profileState(), onBack);

    expectSettled(root);
    expect(status(root)).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    select(root, "other").click();
    expectPending(root, "other");
  });

  it("never lets a stale timeout overwrite a different view", () => {
    select(root, "work").click();
    root.textContent = "A different view";
    vi.advanceTimersByTime(20_000);

    expect(root.textContent).toBe("A different view");
    renderProfiles(root, profileState(), onBack);
    expectSettled(root);
    expect(status(root)).toBe("");
  });

  it("leaves the switcher once after starting a new profile", () => {
    const staleAdd = addButton(root);
    staleAdd.click();
    staleAdd.click();

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: "new-profile" });
    expect(onBack).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    renderProfiles(root, profileState(), onBack);
    expectSettled(root);
  });

  it("retains add-new behavior for a single profile", () => {
    renderProfiles(root, profileState({ profiles: [personal] }), onBack);
    expect(root.querySelector(".profile-delete-btn")).toBeNull();
    addButton(root).click();

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: "new-profile" });
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("uses sibling selection and delete buttons, with keyboard navigation between selectable profiles", () => {
    const workButton = select(root, "work");
    const otherButton = select(root, "other");
    const del = deleteButton(root, "work");
    expect(workButton.tagName).toBe("BUTTON");
    expect(workButton.type).toBe("button");
    expect(workButton.contains(del)).toBe(false);
    expect(workButton.parentElement).toBe(del.parentElement);
    expect(del.getAttribute("aria-label")).toBe("Delete profile Work");

    workButton.focus();
    workButton.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(otherButton);
    otherButton.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(workButton);
    // Native buttons provide Enter/Space activation in the browser.
    workButton.click();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: "switch-profile", profileID: "work" });
  });

  it("does nothing when deletion is cancelled", () => {
    vi.mocked(confirm).mockReturnValue(false);
    deleteButton(root, "work").click();

    expect(confirm).toHaveBeenCalledExactlyOnceWith('Delete profile "Work"?');
    expect(sendMessage).not.toHaveBeenCalled();
    expectSettled(root);
    expect(select(root, "work").disabled).toBe(false);
  });

  it("locks commands while deleting and waits for the profile list to confirm removal", () => {
    const staleDelete = deleteButton(root, "work");
    staleDelete.click();
    staleDelete.click();

    expect(confirm).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: "delete-profile", profileID: "work" });
    expectPending(root);
    expectActive(root, "personal");
    expect(status(root)).toContain("Deleting Work");
    renderProfiles(root, profileState({ stateVersion: 1 }), onBack);
    expectPending(root);

    renderProfiles(root, profileState({ profiles: [personal, other] }), onBack);
    expectSettled(root);
    expectActive(root, "personal");
    expect(status(root)).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    expect(addButton(root).disabled).toBe(false);
  });

  it("allows retry after a deletion timeout or a new delete command error", () => {
    deleteButton(root, "work").click();
    vi.advanceTimersByTime(20_000);
    expectSettled(root);
    expect(status(root)).toContain("try deleting the profile again");
    deleteButton(root, "work").click();
    expectPending(root);
    renderProfiles(root, profileState({ helperDiagnostic: {
      diagnosticCode: "helper-command-delete-profile-error", diagnosticMessage: "failure",
    } }), onBack);
    expectSettled(root);
    expect(status(root)).toContain("could not delete the profile");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps sessions independent for separate roots", () => {
    const secondRoot = document.createElement("div");
    renderProfiles(secondRoot, profileState(), vi.fn());
    select(root, "work").click();
    expect(select(secondRoot, "other").disabled).toBe(false);
    select(secondRoot, "other").click();
    renderProfiles(root, profileState({ currentProfile: work }), onBack);

    expectSettled(root);
    expectPending(secondRoot, "other");
    expect(vi.getTimerCount()).toBe(1);
  });
});
