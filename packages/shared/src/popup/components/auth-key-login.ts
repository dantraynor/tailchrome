import type { TailscaleState } from "../../types";
import { sendMessage } from "../popup";

/**
 * "Use an auth key" sign-in for the needs-login view (#154): registers this
 * browser profile with a pre-authorized (optionally tagged) key instead of an
 * interactive browser login. The key goes to the helper once and is never
 * saved by the extension; the input is cleared as soon as it is submitted.
 */

/** Open state survives the view's re-renders while the popup stays open. */
let formOpen = false;

const INPUT_SELECTOR = ".auth-key-input";

export function createAuthKeyLogin(state: TailscaleState): HTMLElement | null {
  if (!state.supportsAuthKeyLogin) return null;

  const section = document.createElement("div");
  section.className = "auth-key-login";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "btn btn-ghost auth-key-toggle";
  toggle.textContent = "Use an auth key";
  toggle.setAttribute("aria-expanded", String(formOpen));
  section.appendChild(toggle);

  const form = document.createElement("form");
  form.className = "auth-key-form";
  form.hidden = !formOpen;
  form.noValidate = true;
  form.autocomplete = "off";

  const label = document.createElement("label");
  label.className = "auth-key-label";
  label.textContent = "Auth key";
  label.htmlFor = "auth-key-input";
  form.appendChild(label);

  const input = document.createElement("input");
  input.id = "auth-key-input";
  input.type = "password";
  input.className = "coordination-server-input auth-key-input";
  input.placeholder = "tskey-auth-…";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.autocapitalize = "off";
  form.appendChild(input);

  const note = document.createElement("p");
  note.className = "coordination-server-note";
  note.textContent =
    "Registers this browser profile with a pre-authorized key. The key is used once and not saved.";
  form.appendChild(note);

  const error = document.createElement("p");
  error.className = "coordination-server-error";
  error.hidden = true;
  form.appendChild(error);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "btn btn-secondary auth-key-submit";
  submit.textContent = "Sign in with key";
  form.appendChild(submit);

  toggle.addEventListener("click", () => {
    formOpen = !formOpen;
    form.hidden = !formOpen;
    toggle.setAttribute("aria-expanded", String(formOpen));
    if (formOpen) input.focus();
  });

  input.addEventListener("input", () => {
    error.hidden = true;
    error.textContent = "";
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const authKey = input.value.trim();
    if (authKey === "" || /\s/.test(authKey)) {
      error.hidden = false;
      error.textContent = "Paste a single auth key without spaces.";
      return;
    }
    input.value = "";
    sendMessage({ type: "login-auth-key", authKey });
  });

  section.appendChild(form);
  return section;
}

export interface AuthKeyEdit {
  value: string;
  focused: boolean;
  selStart: number | null;
  selEnd: number | null;
}

/** Captures an in-progress key so a status re-render does not discard it. */
export function readAuthKeyEdit(root: ParentNode): AuthKeyEdit | null {
  const input = root.querySelector<HTMLInputElement>(INPUT_SELECTOR);
  if (!input || input.value === "") return null;
  return {
    value: input.value,
    focused: document.activeElement === input,
    selStart: input.selectionStart,
    selEnd: input.selectionEnd,
  };
}

export function restoreAuthKeyEdit(root: ParentNode, edit: AuthKeyEdit): void {
  const input = root.querySelector<HTMLInputElement>(INPUT_SELECTOR);
  if (!input) return;
  input.value = edit.value;
  if (!edit.focused) return;
  input.focus();
  try {
    input.setSelectionRange(edit.selStart, edit.selEnd);
  } catch {
    // Some environments reject setSelectionRange; the value is what matters.
  }
}

/** Test hook: reset module state between tests. */
export function resetAuthKeyLoginForTest(): void {
  formOpen = false;
}
