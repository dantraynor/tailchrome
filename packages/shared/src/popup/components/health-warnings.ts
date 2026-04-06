import { iconWarning, iconChevronDown, iconChevronUp } from "../icons";

/**
 * Renders health warnings as a collapsible banner above the peer list.
 */
export function renderHealthWarnings(
  container: HTMLElement,
  warnings: string[]
): void {
  if (warnings.length === 0) return;

  const banner = document.createElement("div");
  banner.className = "health-warnings";

  const header = document.createElement("div");
  header.className = "health-warnings-header";

  const icon = document.createElement("span");
  icon.className = "health-warnings-icon";
  const iconInner = document.createElement("span");
  iconInner.className = "icon";
  iconInner.appendChild(iconWarning());
  icon.appendChild(iconInner);

  const label = document.createElement("span");
  label.className = "health-warnings-label";
  label.textContent =
    warnings.length === 1
      ? "1 warning"
      : `${warnings.length} warnings`;

  header.appendChild(icon);
  header.appendChild(label);

  const list = document.createElement("ul");
  list.className = "health-warnings-list";
  const listId = "health-warnings-list";
  list.id = listId;

  for (const warning of warnings) {
    const item = document.createElement("li");
    item.className = "health-warnings-item";
    item.textContent = warning;
    list.appendChild(item);
  }

  // Toggle list visibility on header click
  let expanded = warnings.length <= 2;
  if (!expanded) {
    list.classList.add("collapsed");
  }

  if (warnings.length > 2) {
    const chevron = document.createElement("span");
    chevron.className = "health-warnings-chevron";
    const chevronIcon = document.createElement("span");
    chevronIcon.className = "icon";
    chevronIcon.appendChild(expanded ? iconChevronUp() : iconChevronDown());
    chevron.appendChild(chevronIcon);

    header.appendChild(chevron);
    header.classList.add("health-warnings-header--clickable");
    header.setAttribute("role", "button");
    header.setAttribute("tabindex", "0");
    header.setAttribute("aria-expanded", String(expanded));
    header.setAttribute("aria-controls", listId);

    const toggle = () => {
      expanded = !expanded;
      list.classList.toggle("collapsed", !expanded);
      chevronIcon.textContent = "";
      chevronIcon.appendChild(expanded ? iconChevronUp() : iconChevronDown());
      header.setAttribute("aria-expanded", String(expanded));
    };

    header.addEventListener("click", toggle);
    header.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
  }

  banner.appendChild(header);
  banner.appendChild(list);
  container.appendChild(banner);
}
