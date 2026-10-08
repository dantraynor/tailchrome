import type { TailscaleState, ProfileInfo } from "../../types";
import { sendMessage } from "../popup";
import { iconArrowLeft, iconX } from "../icons";
import { addListKeyboardNav } from "../utils";

const PROFILE_COMMAND_TIMEOUT_MS = 20_000;

interface PendingCommand {
  type: "switch-profile" | "delete-profile";
  profileID: string;
  name: string;
}

interface ProfileSession {
  view: HTMLElement | null;
  state: TailscaleState;
  onBack: () => void;
  confirmedProfileID: string | null;
  pending: PendingCommand | null;
  timer: ReturnType<typeof setTimeout> | null;
  diagnostic: string;
  feedback: string | null;
}

// A session belongs to one open switcher, even when status updates replace its DOM.
const sessions = new WeakMap<HTMLElement, ProfileSession>();

function clearPending(session: ProfileSession): void {
  if (session.timer !== null) clearTimeout(session.timer);
  session.timer = null;
  session.pending = null;
}

function closeSession(root: HTMLElement, session: ProfileSession): void {
  clearPending(session);
  if (sessions.get(root) === session) sessions.delete(root);
}

function diagnosticKey(state: TailscaleState): string {
  const diagnostic = state.helperDiagnostic;
  return JSON.stringify([
    diagnostic?.diagnosticCode ?? null,
    diagnostic?.diagnosticMessage ?? null,
  ]);
}

function helperUnavailable(state: TailscaleState): boolean {
  return !state.hostConnected || !!state.helperFailure;
}

/** Render helper-confirmed selection, with pending feedback local to this overlay. */
export function renderProfiles(
  root: HTMLElement,
  state: TailscaleState,
  onBack: () => void,
): void {
  let session = sessions.get(root);
  // Another view may have replaced the switcher without using its Back button.
  if (!session || session.view?.parentElement !== root) {
    if (session) closeSession(root, session);
    session = {
      view: null,
      state,
      onBack,
      confirmedProfileID: state.currentProfile?.id || null,
      pending: null,
      timer: null,
      diagnostic: diagnosticKey(state),
      feedback: null,
    };
    sessions.set(root, session);
  }

  const diagnostic = diagnosticKey(state);
  const pending = session.pending;
  if (pending) {
    if (helperUnavailable(state)) {
      clearPending(session);
      session.feedback = "The helper connection was lost before confirming the change. Reconnect, then try again.";
    } else if (
      pending.type === "switch-profile"
        ? state.currentProfile?.id === pending.profileID
        : !state.profiles.some((profile) => profile.id === pending.profileID)
    ) {
      clearPending(session);
      session.feedback = null;
    } else if (
      diagnostic !== session.diagnostic &&
      state.helperDiagnostic?.diagnosticCode === `helper-command-${pending.type}-error`
    ) {
      clearPending(session);
      session.feedback = pending.type === "switch-profile"
        ? "The helper could not switch profiles. Select a profile to try again."
        : "The helper could not delete the profile. Try deleting it again.";
    }
  }
  session.diagnostic = diagnostic;
  session.state = state;
  session.onBack = onBack;
  // A temporary empty identity is not confirmation of a different profile.
  if (state.currentProfile?.id) {
    if (!session.pending && session.confirmedProfileID !== state.currentProfile.id) {
      session.feedback = null;
    }
    session.confirmedProfileID = state.currentProfile.id;
  }

  const activeSession = session;
  root.textContent = "";
  const view = document.createElement("div");
  view.className = "view profiles-view";
  activeSession.view = view;

  const canRunCommand = () =>
    sessions.get(root) === activeSession &&
    activeSession.view === view &&
    view.parentElement === root &&
    !activeSession.pending &&
    !helperUnavailable(activeSession.state);

  const beginCommand = (command: PendingCommand) => {
    if (!canRunCommand()) return;
    activeSession.pending = command;
    activeSession.feedback = null;
    activeSession.timer = setTimeout(() => {
      // Never let an abandoned overlay's timer replace a newer view.
      if (
        sessions.get(root) !== activeSession ||
        activeSession.view?.parentElement !== root
      ) {
        closeSession(root, activeSession);
        return;
      }
      clearPending(activeSession);
      activeSession.feedback = command.type === "switch-profile"
        ? "The helper did not confirm the profile switch within 20 seconds. Check the connection, then select a profile to try again."
        : "The helper did not confirm the deletion within 20 seconds. Check the connection, then try deleting the profile again.";
      renderProfiles(root, activeSession.state, activeSession.onBack);
    }, PROFILE_COMMAND_TIMEOUT_MS);
    renderProfiles(root, activeSession.state, activeSession.onBack);
    sendMessage({ type: command.type, profileID: command.profileID });
  };

  const header = document.createElement("div");
  header.className = "exit-nodes-header";

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "btn btn-ghost";
  const backIcon = document.createElement("span");
  backIcon.className = "icon icon-sm";
  backIcon.appendChild(iconArrowLeft());
  backBtn.appendChild(backIcon);
  backBtn.appendChild(document.createTextNode(" Back"));
  backBtn.addEventListener("click", () => {
    if (sessions.get(root) !== activeSession || activeSession.view !== view) return;
    closeSession(root, activeSession);
    activeSession.onBack();
  });
  header.appendChild(backBtn);

  const title = document.createElement("h3");
  title.className = "exit-nodes-title";
  title.textContent = "Profiles";
  header.appendChild(title);
  view.appendChild(header);

  const list = document.createElement("div");
  list.className = "profile-list";
  list.setAttribute("aria-busy", String(!!activeSession.pending));
  addListKeyboardNav(list, ".profile-select-btn:not(:disabled)");

  const commandsDisabled = !!activeSession.pending || helperUnavailable(state);
  for (const profile of state.profiles) {
    const isCurrent = activeSession.confirmedProfileID === profile.id;
    const command = activeSession.pending?.profileID === profile.id
      ? activeSession.pending
      : null;
    list.appendChild(createProfileRow(
      profile,
      isCurrent,
      state.profiles.length > 1,
      commandsDisabled,
      command,
      () => beginCommand({ type: "switch-profile", profileID: profile.id, name: profile.name || profile.id }),
      () => {
        if (!canRunCommand()) return;
        if (confirm(`Delete profile "${profile.name || profile.id}"?`)) {
          beginCommand({ type: "delete-profile", profileID: profile.id, name: profile.name || profile.id });
        }
      },
    ));
  }
  view.appendChild(list);

  const status = document.createElement("div");
  status.className = "empty-state-text profile-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = activeSession.pending
    ? `${activeSession.pending.type === "switch-profile" ? "Switching to" : "Deleting"} ${activeSession.pending.name}… Waiting for the helper to confirm.`
    : activeSession.feedback ?? (helperUnavailable(state) ? "The helper is disconnected. Reconnect to manage profiles." : "");
  view.appendChild(status);

  const addRow = document.createElement("div");
  addRow.className = "profile-add-row";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "btn btn-secondary";
  addBtn.textContent = "+ Add Profile";
  addBtn.disabled = commandsDisabled;
  addBtn.addEventListener("click", () => {
    if (!canRunCommand()) return;
    // The new profile has no identity until sign-in. Leave for the login view.
    closeSession(root, activeSession);
    sendMessage({ type: "new-profile" });
    activeSession.onBack();
  });
  addRow.appendChild(addBtn);
  view.appendChild(addRow);
  root.appendChild(view);
}

function createProfileRow(
  profile: ProfileInfo,
  isCurrent: boolean,
  canDelete: boolean,
  commandsDisabled: boolean,
  pending: PendingCommand | null,
  onSelect: () => void,
  onDelete: () => void,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "profile-row" + (isCurrent ? " profile-row--current" : "");
  row.dataset.profileId = profile.id;

  const selectBtn = document.createElement("button");
  selectBtn.type = "button";
  selectBtn.className = "btn btn-ghost profile-select-btn";
  selectBtn.disabled = isCurrent || commandsDisabled;
  selectBtn.setAttribute("aria-pressed", String(isCurrent));
  selectBtn.addEventListener("click", onSelect);

  const radio = document.createElement("span");
  radio.className = "exit-node-radio" + (isCurrent ? " exit-node-radio--selected" : "");
  radio.setAttribute("aria-hidden", "true");
  selectBtn.appendChild(radio);

  const info = document.createElement("span");
  info.className = "profile-info";
  const nameEl = document.createElement("span");
  nameEl.className = "profile-name";
  nameEl.textContent = profile.name || profile.id;
  info.appendChild(nameEl);

  if (isCurrent || pending) {
    const badge = document.createElement("span");
    badge.className = "profile-badge";
    badge.textContent = isCurrent ? "Active" : pending?.type === "switch-profile" ? "Switching…" : "Deleting…";
    info.appendChild(badge);
  }
  selectBtn.appendChild(info);
  row.appendChild(selectBtn);

  if (pending) {
    row.classList.add("profile-row--pending");
    const spinner = document.createElement("span");
    spinner.className = "spinner spinner-sm";
    spinner.setAttribute("aria-hidden", "true");
    row.appendChild(spinner);
  }

  if (!isCurrent && canDelete) {
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "profile-delete-btn";
    deleteBtn.title = "Delete profile";
    deleteBtn.setAttribute("aria-label", `Delete profile ${profile.name || profile.id}`);
    deleteBtn.disabled = commandsDisabled;
    const delIcon = document.createElement("span");
    delIcon.className = "icon icon-sm";
    delIcon.appendChild(iconX());
    deleteBtn.appendChild(delIcon);
    deleteBtn.addEventListener("click", onDelete);
    row.appendChild(deleteBtn);
  }

  return row;
}
