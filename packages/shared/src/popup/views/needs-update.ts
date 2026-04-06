import { renderInstallFlow } from "./install-helpers";

/**
 * Renders the native host version-mismatch view.
 * Shows a platform-adaptive stepper UI to guide the user through updating.
 */
export function renderNeedsUpdate(root: HTMLElement, hostVersion: string | null): void {
  renderInstallFlow(root, { mode: "update", hostVersion });
}
