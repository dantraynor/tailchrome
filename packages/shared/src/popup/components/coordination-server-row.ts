import type { TailscaleState } from "../../types";
import { DEFAULT_CONTROL_URL } from "../../constants";
import { sendMessage } from "../popup";
import { createToggle } from "./toggle-switch";

/**
 * Coordination server (control plane) editor: a collapsible header + URL input
 * + Save button. Used in connected, needs-login, and disconnected views so the
 * URL can be configured before the first login as well as after.
 *
 * Returns the header row, an editor section (already configured to hide/show
 * with the toggle), and an `update` function that re-syncs the input value and
 * capability gating against fresh state. Callers append both elements to their
 * container in order.
 */
export interface CoordinationServerRow {
  header: HTMLElement;
  editor: HTMLElement;
  /** Re-sync input value (when not focused) and capability gating against new state. */
  update(state: TailscaleState): void;
}

const rowsByEditor = new WeakMap<HTMLElement, CoordinationServerRow>();

export function createCoordinationServerRow(
  state: TailscaleState,
  initialOpen: boolean,
  onOpenChange?: (open: boolean) => void,
): CoordinationServerRow {
  let isOpen = initialOpen;

  const header = document.createElement("div");
  header.className = "setting-row";
  const label = document.createElement("span");
  label.className = "setting-label";
  label.textContent = "Coordination server";
  header.appendChild(label);

  const editor = document.createElement("div");
  editor.className = "setting-row setting-row--stacked coordination-server-editor";
  if (!isOpen) editor.classList.add("hidden");

  const expand = createToggle(isOpen, (checked) => {
    isOpen = checked;
    editor.classList.toggle("hidden", !checked);
    onOpenChange?.(checked);
  });
  header.appendChild(expand);

  const input = document.createElement("input");
  input.type = "url";
  input.className = "coordination-server-input";
  input.placeholder = DEFAULT_CONTROL_URL;
  input.value = state.prefs?.controlURL ?? "";
  // `dirty` tracks whether the value holds unsaved user edits, so a routine
  // status update never clobbers what the user is typing (see `update`).
  input.dataset["dirty"] = "false";
  input.spellcheck = false;
  input.autocapitalize = "off";
  editor.appendChild(input);

  const note = document.createElement("p");
  note.className = "coordination-server-note";
  editor.appendChild(note);

  const error = document.createElement("p");
  error.className = "coordination-server-error";
  error.hidden = true;
  editor.appendChild(error);

  function clearValidationError(): void {
    error.hidden = true;
    error.textContent = "";
  }

  input.addEventListener("input", () => {
    input.dataset["dirty"] = "true";
    clearValidationError();
  });

  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn btn-secondary coordination-server-save";
  save.textContent = "Save server";
  save.addEventListener("click", () => {
    if (save.disabled) return;
    const raw = input.value.trim();
    if (raw !== "") {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        error.hidden = false;
        error.textContent = "Enter a valid URL (e.g. https://headscale.example.com).";
        return;
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        error.hidden = false;
        error.textContent = "Coordination server URL must use http:// or https://.";
        return;
      }
    }
    clearValidationError();
    input.dataset["dirty"] = "false";
    sendMessage({ type: "set-pref", key: "controlURL", value: raw });
  });
  editor.appendChild(save);

  function applyCapability(supported: boolean): void {
    input.disabled = !supported;
    save.disabled = !supported;
    note.textContent = supported
      ? "Leave blank for the default Tailscale server. Saving signs you out and requires a new login."
      : "Update the native helper to change the coordination server.";
  }

  applyCapability(state.supportsCustomControlURL);

  const row: CoordinationServerRow = {
    header,
    editor,
    update(next: TailscaleState): void {
      applyCapability(next.supportsCustomControlURL);
      const desired = next.prefs?.controlURL ?? "";
      // Never overwrite a focused input or one holding unsaved edits, so an
      // in-progress (or invalid, error-flagged) value survives status updates.
      if (document.activeElement === input) return;
      if (input.value === desired) {
        input.dataset["dirty"] = "false";
        clearValidationError();
      } else if (input.dataset["dirty"] !== "true") {
        input.value = desired;
        clearValidationError();
      }
    },
  };
  rowsByEditor.set(editor, row);
  return row;
}

export function updateCoordinationServerRow(
  root: ParentNode,
  state: TailscaleState,
): boolean {
  const editor = root.querySelector<HTMLElement>(".coordination-server-editor");
  if (!editor) return false;
  const row = rowsByEditor.get(editor);
  if (!row) return false;
  row.update(state);
  return true;
}

/**
 * Shared open-state for the coordination editor on the standalone screens
 * (disconnected / needs-login), where it sits in its own `.quick-settings`
 * block. (The connected view embeds the editor inside its Advanced section and
 * tracks that independently.)
 */
let standaloneEditorOpen = false;

/**
 * Mounts the coordination-server editor, wrapped in a `.quick-settings` block,
 * into a standalone view. Used by the disconnected and needs-login views so the
 * markup and open-state handling live in one place.
 */
export function appendCoordinationServerSettings(
  view: HTMLElement,
  state: TailscaleState,
): void {
  const settings = document.createElement("div");
  settings.className = "quick-settings";
  const row = createCoordinationServerRow(state, standaloneEditorOpen, (open) => {
    standaloneEditorOpen = open;
  });
  settings.appendChild(row.header);
  settings.appendChild(row.editor);
  view.appendChild(settings);
}

interface CoordEditState {
  value: string;
  dirty: boolean;
  selStart: number | null;
  selEnd: number | null;
}

function readFocusedCoordEdit(root: ParentNode): CoordEditState | null {
  const input = root.querySelector<HTMLInputElement>(".coordination-server-input");
  if (!input || document.activeElement !== input) return null;
  return {
    value: input.value,
    dirty: input.dataset["dirty"] === "true",
    selStart: input.selectionStart,
    selEnd: input.selectionEnd,
  };
}

function restoreCoordEdit(root: ParentNode, edit: CoordEditState): void {
  const input = root.querySelector<HTMLInputElement>(".coordination-server-input");
  if (!input) return;
  input.value = edit.value;
  input.dataset["dirty"] = edit.dirty ? "true" : "false";
  input.focus();
  try {
    input.setSelectionRange(edit.selStart, edit.selEnd);
  } catch {
    // Some environments reject setSelectionRange on url inputs; ignore.
  }
}

/**
 * In-place update path for the standalone views: re-renders the whole view so
 * all state-dependent content stays fresh, while preserving an in-progress edit
 * in the coordination-server input (value, dirty flag, focus, and caret). This
 * keeps the disconnected and needs-login views consistent and avoids leaving
 * the rest of the view stale while the input is focused.
 */
export function rerenderPreservingCoordEdit(
  root: HTMLElement,
  state: TailscaleState,
  render: (root: HTMLElement, state: TailscaleState) => void,
): void {
  const edit = readFocusedCoordEdit(root);
  render(root, state);
  if (edit) restoreCoordEdit(root, edit);
}
