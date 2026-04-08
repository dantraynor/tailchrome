/**
 * SVG icon library for the popup UI.
 * All icons use currentColor for automatic dark mode support.
 * Standard viewBox is 24x24 with 1.5px stroke for consistency.
 */

const NS = "http://www.w3.org/2000/svg";

function svg(viewBox = "0 0 24 24"): SVGSVGElement {
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", viewBox);
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", "currentColor");
  el.setAttribute("stroke-width", "1.5");
  el.setAttribute("stroke-linecap", "round");
  el.setAttribute("stroke-linejoin", "round");
  return el;
}

function path(d: string): SVGPathElement {
  const el = document.createElementNS(NS, "path");
  el.setAttribute("d", d);
  return el;
}

function circle(cx: number, cy: number, r: number): SVGCircleElement {
  const el = document.createElementNS(NS, "circle");
  el.setAttribute("cx", String(cx));
  el.setAttribute("cy", String(cy));
  el.setAttribute("r", String(r));
  return el;
}

function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  rx = 0,
): SVGRectElement {
  const el = document.createElementNS(NS, "rect");
  el.setAttribute("x", String(x));
  el.setAttribute("y", String(y));
  el.setAttribute("width", String(w));
  el.setAttribute("height", String(h));
  if (rx) el.setAttribute("rx", String(rx));
  return el;
}

function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): SVGLineElement {
  const el = document.createElementNS(NS, "line");
  el.setAttribute("x1", String(x1));
  el.setAttribute("y1", String(y1));
  el.setAttribute("x2", String(x2));
  el.setAttribute("y2", String(y2));
  return el;
}

/** Laptop icon (macOS, default) */
export function iconLaptop(): SVGSVGElement {
  const s = svg();
  s.appendChild(path("M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8H4V6z"));
  s.appendChild(path("M2 18h20"));
  return s;
}

/** Desktop monitor icon (Linux, FreeBSD) */
export function iconDesktop(): SVGSVGElement {
  const s = svg();
  s.appendChild(rect(3, 3, 18, 13, 2));
  s.appendChild(line(9, 20, 15, 20));
  s.appendChild(line(12, 16, 12, 20));
  return s;
}

/** Window/app icon (Windows) */
export function iconWindow(): SVGSVGElement {
  const s = svg();
  s.appendChild(rect(3, 3, 18, 18, 2));
  s.appendChild(line(3, 9, 21, 9));
  s.appendChild(line(9, 3, 9, 9));
  return s;
}

/** Smartphone icon (iOS, Android) */
export function iconMobile(): SVGSVGElement {
  const s = svg();
  s.appendChild(rect(6, 2, 12, 20, 2));
  s.appendChild(line(10, 18, 14, 18));
  return s;
}

/** Package/box icon (install) */
export function iconPackage(): SVGSVGElement {
  const s = svg();
  s.appendChild(path("M16.5 9.4l-9-5.19"));
  s.appendChild(
    path(
      "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z",
    ),
  );
  s.appendChild(path("M3.27 6.96L12 12.01l8.73-5.05"));
  s.appendChild(line(12, 22.08, 12, 12));
  return s;
}

/** Refresh/update icon */
export function iconRefresh(): SVGSVGElement {
  const s = svg();
  s.appendChild(path("M1 4v6h6"));
  s.appendChild(path("M23 20v-6h-6"));
  s.appendChild(path("M20.49 9A9 9 0 0 0 5.64 5.64L1 10"));
  s.appendChild(path("M3.51 15A9 9 0 0 0 18.36 18.36L23 14"));
  return s;
}

/** Lock icon (login) */
export function iconLock(): SVGSVGElement {
  const s = svg();
  s.appendChild(rect(3, 11, 18, 11, 2));
  s.appendChild(path("M7 11V7a5 5 0 0 1 10 0v4"));
  return s;
}

/** Plug/power off icon (disconnected) */
export function iconPlug(): SVGSVGElement {
  const s = svg();
  s.appendChild(line(12, 2, 12, 6));
  s.appendChild(line(8, 2, 8, 6));
  s.appendChild(line(16, 2, 16, 6));
  s.appendChild(path("M4 6h16v4a8 8 0 0 1-8 8 8 8 0 0 1-8-8V6z"));
  s.appendChild(line(12, 18, 12, 22));
  return s;
}

/** Search / magnifying glass icon */
export function iconSearch(): SVGSVGElement {
  const s = svg();
  s.appendChild(circle(11, 11, 8));
  s.appendChild(line(21, 21, 16.65, 16.65));
  return s;
}

/** Warning triangle icon */
export function iconWarning(): SVGSVGElement {
  const s = svg();
  s.setAttribute("fill", "currentColor");
  s.setAttribute("stroke", "none");
  s.appendChild(
    path(
      "M12 2L1 21h22L12 2zm0 4l7.53 13H4.47L12 6zm-1 5v4h2v-4h-2zm0 6v2h2v-2h-2z",
    ),
  );
  return s;
}

/** Chevron down icon */
export function iconChevronDown(): SVGSVGElement {
  const s = svg();
  s.appendChild(path("M6 9l6 6 6-6"));
  return s;
}

/** Chevron up icon */
export function iconChevronUp(): SVGSVGElement {
  const s = svg();
  s.appendChild(path("M18 15l-6-6-6 6"));
  return s;
}

/** Arrow left icon (back) */
export function iconArrowLeft(): SVGSVGElement {
  const s = svg();
  s.appendChild(line(19, 12, 5, 12));
  s.appendChild(path("M12 19l-7-7 7-7"));
  return s;
}

/** Chevron right icon (navigation hint) */
export function iconChevronRight(): SVGSVGElement {
  const s = svg();
  s.appendChild(path("M9 18l6-6-6-6"));
  return s;
}

/** X / close icon */
export function iconX(): SVGSVGElement {
  const s = svg();
  s.appendChild(line(18, 6, 6, 18));
  s.appendChild(line(6, 6, 18, 18));
  return s;
}

/** Shield icon (shields up) */
export function iconShield(): SVGSVGElement {
  const s = svg();
  s.appendChild(path("M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"));
  return s;
}

/**
 * Returns a device icon SVGSVGElement for the given OS name.
 */
export function iconForOS(os: string): SVGSVGElement {
  const lower = os.toLowerCase();
  if (lower.includes("macos") || lower.includes("darwin")) return iconLaptop();
  if (lower.includes("linux")) return iconDesktop();
  if (lower.includes("windows")) return iconWindow();
  if (lower.includes("ios") || lower.includes("iphone") || lower.includes("ipad")) return iconMobile();
  if (lower.includes("android")) return iconMobile();
  if (lower.includes("freebsd") || lower.includes("openbsd")) return iconDesktop();
  return iconLaptop();
}
