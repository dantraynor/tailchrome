// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { baseState } from "../../__test__/fixtures";
import {
  createCoordinationServerRow,
  updateCoordinationServerRow,
} from "./coordination-server-row";
import { sendMessage } from "../popup";

vi.mock("../popup", () => ({
  sendMessage: vi.fn(),
}));

describe("CoordinationServerRow", () => {
  it("clears validation errors when a status update restores a valid value", () => {
    const container = document.createElement("div");
    const row = createCoordinationServerRow(
      baseState({
        supportsCustomControlURL: true,
        prefs: {
          controlURL: "",
          exitNodeID: "",
          exitNodeAllowLANAccess: false,
          corpDNS: true,
          shieldsUp: false,
          advertiseExitNode: false,
        },
      }),
      true,
    );
    container.appendChild(row.header);
    container.appendChild(row.editor);

    const input = container.querySelector<HTMLInputElement>(".coordination-server-input")!;
    const save = container.querySelector<HTMLButtonElement>(".coordination-server-save")!;
    const error = container.querySelector<HTMLElement>(".coordination-server-error")!;

    input.value = "not a url";
    save.click();
    expect(error.hidden).toBe(false);

    updateCoordinationServerRow(
      container,
      baseState({
        supportsCustomControlURL: true,
        prefs: {
          controlURL: "",
          exitNodeID: "",
          exitNodeAllowLANAccess: false,
          corpDNS: true,
          shieldsUp: false,
          advertiseExitNode: false,
        },
      }),
    );

    expect(input.value).toBe("");
    expect(error.hidden).toBe(true);
    expect(error.textContent).toBe("");
  });

  it("updates capability gating through the component update hook", () => {
    const container = document.createElement("div");
    const row = createCoordinationServerRow(baseState(), true);
    container.appendChild(row.header);
    container.appendChild(row.editor);

    const input = container.querySelector<HTMLInputElement>(".coordination-server-input")!;
    const save = container.querySelector<HTMLButtonElement>(".coordination-server-save")!;
    const note = container.querySelector<HTMLElement>(".coordination-server-note")!;
    expect(input.disabled).toBe(true);
    expect(save.disabled).toBe(true);

    updateCoordinationServerRow(
      container,
      baseState({ supportsCustomControlURL: true }),
    );

    expect(input.disabled).toBe(false);
    expect(save.disabled).toBe(false);
    expect(note.textContent).toContain("Leave blank");
  });

  it("sends trimmed controlURL values", () => {
    const container = document.createElement("div");
    const row = createCoordinationServerRow(
      baseState({ supportsCustomControlURL: true }),
      true,
    );
    container.appendChild(row.header);
    container.appendChild(row.editor);

    const input = container.querySelector<HTMLInputElement>(".coordination-server-input")!;
    const save = container.querySelector<HTMLButtonElement>(".coordination-server-save")!;
    input.value = " https://hs.example.com ";
    save.click();

    expect(sendMessage).toHaveBeenCalledWith({
      type: "set-pref",
      key: "controlURL",
      value: "https://hs.example.com",
    });
  });
});
