// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { TailscaleState } from "../../types";
import { baseState } from "../../__test__/fixtures";
import {
  appendCoordinationServerSettings,
  createCoordinationServerRow,
  rerenderPreservingCoordEdit,
  updateCoordinationServerRow,
} from "./coordination-server-row";
import { sendMessage } from "../popup";

vi.mock("../popup", () => ({
  sendMessage: vi.fn(),
}));

function customServerState(controlURL = ""): TailscaleState {
  return baseState({
    supportsCustomControlURL: true,
    prefs: {
      controlURL,
      exitNodeID: "",
      exitNodeAllowLANAccess: false,
      corpDNS: true,
      shieldsUp: false,
      advertiseExitNode: false,
    },
  });
}

describe("CoordinationServerRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

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

  it("accepts http:// coordination URLs for HTTP Headscale servers", () => {
    const container = document.createElement("div");
    const row = createCoordinationServerRow(customServerState(), true);
    container.appendChild(row.header);
    container.appendChild(row.editor);

    const input = container.querySelector<HTMLInputElement>(".coordination-server-input")!;
    const save = container.querySelector<HTMLButtonElement>(".coordination-server-save")!;
    input.value = "http://headscale.test:8080";
    save.click();

    expect(sendMessage).toHaveBeenCalledWith({
      type: "set-pref",
      key: "controlURL",
      value: "http://headscale.test:8080",
    });
  });

  it("rejects coordination URLs that are not http(s)", () => {
    const container = document.createElement("div");
    const row = createCoordinationServerRow(customServerState(), true);
    container.appendChild(row.header);
    container.appendChild(row.editor);

    const input = container.querySelector<HTMLInputElement>(".coordination-server-input")!;
    const save = container.querySelector<HTMLButtonElement>(".coordination-server-save")!;
    const error = container.querySelector<HTMLElement>(".coordination-server-error")!;
    input.value = "ftp://headscale.test";
    save.click();

    expect(error.hidden).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("preserves an unsaved value the user is typing across a status update", () => {
    const container = document.createElement("div");
    const row = createCoordinationServerRow(customServerState(""), true);
    container.appendChild(row.header);
    container.appendChild(row.editor);

    const input = container.querySelector<HTMLInputElement>(".coordination-server-input")!;
    // Real typing fires an "input" event, marking the field dirty (a
    // programmatic .value assignment does not).
    input.value = "https://hs.partial";
    input.dispatchEvent(new Event("input"));

    // A routine status update (still on the default server) must not clobber it.
    updateCoordinationServerRow(container, customServerState(""));

    expect(input.value).toBe("https://hs.partial");
  });

  it("rerenderPreservingCoordEdit refreshes view content but keeps a focused edit", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);

    const render = (r: HTMLElement, s: TailscaleState): void => {
      r.textContent = "";
      const view = document.createElement("div");
      view.className = "view";
      const title = document.createElement("h2");
      title.className = "view-title";
      title.textContent = s.backendState;
      view.appendChild(title);
      appendCoordinationServerSettings(view, s);
      r.appendChild(view);
    };

    render(root, customServerState());
    const input = root.querySelector<HTMLInputElement>(".coordination-server-input")!;
    input.value = "https://hs.partial";
    input.dispatchEvent(new Event("input"));
    input.focus();

    rerenderPreservingCoordEdit(
      root,
      { ...customServerState(), backendState: "Starting" },
      render,
    );

    // View content reflects the new state…
    expect(root.querySelector(".view-title")!.textContent).toBe("Starting");
    // …and the in-progress edit (value + focus) is preserved.
    const newInput = root.querySelector<HTMLInputElement>(".coordination-server-input")!;
    expect(newInput.value).toBe("https://hs.partial");
    expect(document.activeElement).toBe(newInput);
  });
});
