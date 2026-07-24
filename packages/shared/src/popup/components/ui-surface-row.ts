import { readUiSurface, writeUiSurface, type UiSurface } from "../../background/ui-surface";
import { createToggle } from "./toggle-switch";

export async function renderUiSurfaceRow(parent: HTMLElement): Promise<void> {
  const current = await readUiSurface();
  const row = document.createElement("div");
  row.className = "setting-row";

  const label = document.createElement("span");
  label.className = "setting-label";
  label.textContent = "Open as side panel";
  row.appendChild(label);

  const toggle = createToggle(current === "sidePanel", (checked) => {
    const next: UiSurface = checked ? "sidePanel" : "popup";
    void writeUiSurface(next);
  }, "Open as side panel");
  row.appendChild(toggle);
  parent.appendChild(row);
}

export function renderUiSurfaceFooter(view: HTMLElement): void {
  const footer = document.createElement("div");
  footer.className = "ui-surface-footer";
  void renderUiSurfaceRow(footer);
  view.appendChild(footer);
}
