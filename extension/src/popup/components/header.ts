import { createToggle } from "./toggle-switch";
import { sendMessage } from "../popup";

/**
 * Creates the Tailscale dot-grid logo icon as DOM elements.
 */
function createLogoIcon(): HTMLElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("fill", "none");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");

  // 3x3 grid of circles representing the Tailscale logo
  const dots: Array<{ cx: number; cy: number; opacity: number }> = [
    { cx: 4, cy: 4, opacity: 0.2 },
    { cx: 4, cy: 10, opacity: 1 },
    { cx: 4, cy: 16, opacity: 0.2 },
    { cx: 10, cy: 4, opacity: 1 },
    { cx: 10, cy: 10, opacity: 1 },
    { cx: 10, cy: 16, opacity: 1 },
    { cx: 16, cy: 4, opacity: 0.2 },
    { cx: 16, cy: 10, opacity: 1 },
    { cx: 16, cy: 16, opacity: 0.2 },
  ];

  for (const dot of dots) {
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", String(dot.cx));
    circle.setAttribute("cy", String(dot.cy));
    circle.setAttribute("r", "3.5");
    circle.setAttribute("fill", "currentColor");
    if (dot.opacity < 1) {
      circle.setAttribute("opacity", String(dot.opacity));
    }
    svg.appendChild(circle);
  }

  const wrapper = document.createElement("span");
  wrapper.appendChild(svg);
  return wrapper;
}

/**
 * Renders the popup header with Tailscale logo and toggle switch.
 */
export function renderHeader(
  container: HTMLElement,
  connected: boolean,
  disabled = false,
): void {
  const header = document.createElement("div");
  header.className = "header";

  const logo = document.createElement("div");
  logo.className = "header-logo";
  logo.appendChild(createLogoIcon());

  const wordmark = document.createElement("span");
  wordmark.className = "header-wordmark";
  wordmark.textContent = "Tailchrome";
  logo.appendChild(wordmark);

  const toggle = createToggle(connected, () => {
    sendMessage({ type: "toggle" });
  }, disabled);

  header.appendChild(logo);
  header.appendChild(toggle);
  container.appendChild(header);
}
