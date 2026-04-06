import type { TailscaleState, ProfileInfo } from "../../types";
import { sendMessage } from "../popup";

/**
 * Renders the profile switcher overlay.
 * Shows the current profile, other profiles to switch to, and options to add/delete.
 */
export function renderProfiles(
  root: HTMLElement,
  state: TailscaleState,
  onBack: () => void
): void {
  root.textContent = "";
  const view = document.createElement("div");
  view.className = "view";

  // --- Header ---
  const header = document.createElement("div");
  header.className = "exit-nodes-header";

  const backBtn = document.createElement("button");
  backBtn.className = "btn btn-ghost";
  backBtn.textContent = "\u2190 Back";
  backBtn.addEventListener("click", onBack);
  header.appendChild(backBtn);

  const title = document.createElement("h3");
  title.className = "exit-nodes-title";
  title.textContent = "Profiles";
  header.appendChild(title);

  view.appendChild(header);

  // --- Profile list ---
  const list = document.createElement("div");
  list.className = "profile-list";

  for (const profile of state.profiles) {
    const isCurrent =
      state.currentProfile !== null && state.currentProfile.id === profile.id;
    list.appendChild(
      createProfileRow(profile, isCurrent, state.profiles.length > 1)
    );
  }

  view.appendChild(list);

  // --- Add profile button ---
  const addRow = document.createElement("div");
  addRow.className = "profile-add-row";

  const addBtn = document.createElement("button");
  addBtn.className = "btn btn-secondary";
  addBtn.textContent = "+ Add Profile";
  addBtn.addEventListener("click", () => {
    sendMessage({ type: "new-profile" });
  });
  addRow.appendChild(addBtn);
  view.appendChild(addRow);

  root.appendChild(view);
}

function createProfileRow(
  profile: ProfileInfo,
  isCurrent: boolean,
  canDelete: boolean
): HTMLElement {
  const row = document.createElement("div");
  row.className =
    "profile-row" + (isCurrent ? " profile-row--current" : "");

  const radio = document.createElement("div");
  radio.className =
    "exit-node-radio" +
    (isCurrent ? " exit-node-radio--selected" : "");
  row.appendChild(radio);

  const info = document.createElement("div");
  info.className = "profile-info";

  const nameEl = document.createElement("span");
  nameEl.className = "profile-name";
  nameEl.textContent = profile.name || profile.id;
  info.appendChild(nameEl);

  if (isCurrent) {
    const badge = document.createElement("span");
    badge.className = "profile-badge";
    badge.textContent = "Active";
    info.appendChild(badge);
  }

  row.appendChild(info);

  if (!isCurrent && canDelete) {
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "profile-delete-btn";
    deleteBtn.textContent = "\u00D7";
    deleteBtn.title = "Delete profile";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(`Delete profile "${profile.name || profile.id}"?`)) {
        sendMessage({ type: "delete-profile", profileID: profile.id });
      }
    });
    row.appendChild(deleteBtn);
  }

  if (!isCurrent) {
    row.addEventListener("click", () => {
      // Show loading spinner for immediate feedback
      const spinner = document.createElement("div");
      spinner.className = "spinner spinner-sm";
      row.appendChild(spinner);
      row.classList.add("profile-row--current");
      sendMessage({ type: "switch-profile", profileID: profile.id });
    });
    row.style.cursor = "pointer";
  }

  return row;
}
