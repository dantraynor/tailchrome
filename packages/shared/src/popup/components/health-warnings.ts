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
  icon.textContent = "\u26A0";

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

  for (const warning of warnings) {
    const item = document.createElement("li");
    item.className = "health-warnings-item";
    item.textContent = warning;
    list.appendChild(item);
  }

  // Toggle list visibility on header click
  let expanded = warnings.length <= 2;
  list.style.display = expanded ? "block" : "none";

  if (warnings.length > 2) {
    const chevron = document.createElement("span");
    chevron.className = "health-warnings-chevron";
    chevron.textContent = expanded ? "\u25B2" : "\u25BC";
    header.appendChild(chevron);

    header.style.cursor = "pointer";
    header.addEventListener("click", () => {
      expanded = !expanded;
      list.style.display = expanded ? "block" : "none";
      chevron.textContent = expanded ? "\u25B2" : "\u25BC";
    });
  }

  banner.appendChild(header);
  banner.appendChild(list);
  container.appendChild(banner);
}
