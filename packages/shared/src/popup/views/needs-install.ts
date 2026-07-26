import type { TailscaleState } from "../../types";
import { renderInstallFlow } from "./install-helpers";

/**
 * Renders the native host not-installed view.
 * Shows a platform-adaptive stepper UI to guide the user through setup.
 */
export function renderNeedsInstall(
  root: HTMLElement,
  state: TailscaleState,
): Promise<void> {
  return renderInstallFlow(root, { mode: "install", state });
}
