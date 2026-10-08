// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makePeer } from "../../__test__/fixtures";
import { filterPeers, renderPeerList, updatePeerList } from "./peer-list";

function actionLabels(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(".peer-action-btn"),
  ).map((btn) => btn.textContent ?? "");
}

describe("updatePeerList", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
  });

  afterEach(() => container.remove());

  const peers = Array.from({ length: 8 }, (_, i) => makePeer({
    id: `peer-${i}`,
    hostname: `device-${i}`,
    dnsName: `device-${i}.example.ts.net.`,
    online: i >= 2,
  }));

  it("previews online devices first and expands/collapses the full list", () => {
    renderPeerList(container, peers, false, false);
    expect(container.querySelectorAll(".peer-item")).toHaveLength(5);
    expect(container.querySelector(".peer-item-container")?.getAttribute("data-peer-id"))
      .toBe("peer-2");
    expect(container.textContent).toContain("Showing 5 of 8 devices");

    container.querySelector<HTMLButtonElement>(".peer-list-toggle")!.click();
    expect(container.querySelectorAll(".peer-item")).toHaveLength(8);
    expect(container.querySelector(".peer-list-toggle")?.getAttribute("aria-expanded")).toBe("true");

    container.querySelector<HTMLButtonElement>(".peer-list-toggle")!.click();
    expect(container.querySelectorAll(".peer-item")).toHaveLength(5);
  });

  it("preserves View all, expanded peer details, and focus across updates", () => {
    document.body.appendChild(container);
    renderPeerList(container, peers, false, false);
    container.querySelector<HTMLButtonElement>(".peer-list-toggle")!.click();
    const row = container.querySelector<HTMLButtonElement>('[data-peer-id="peer-7"] .peer-item')!;
    row.click();
    row.focus();

    updatePeerList(container, peers.map((p) => ({ ...p, rxBytes: 123 })), false, false);

    expect(container.querySelectorAll(".peer-item")).toHaveLength(8);
    expect(container.querySelector('[data-peer-id="peer-7"] .peer-item')).toBe(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(row);
  });

  it("searches hidden devices and shows every match without changing the preview preference", () => {
    renderPeerList(container, peers, false, false);
    updatePeerList(container, peers, false, false, " DEVICE-0 ");
    expect(container.querySelectorAll(".peer-item")).toHaveLength(1);
    expect(container.querySelector(".peer-name")?.textContent).toBe("device-0");

    updatePeerList(container, peers, false, false, "device");
    expect(container.querySelectorAll(".peer-item")).toHaveLength(8);
    expect(container.querySelector(".peer-list-toggle")).toBeNull();

    updatePeerList(container, peers, false, false, "missing");
    expect(container.textContent).toContain("No matching devices");
    expect(container.textContent).not.toContain("once they come online");

    updatePeerList(container, peers, false, false, "");
    expect(container.querySelectorAll(".peer-item")).toHaveLength(5);
  });

  it("uses the latest peers when View all is clicked after an update", () => {
    renderPeerList(container, peers, false, false);
    const latest = peers.slice(0, 7);
    updatePeerList(container, latest, false, false);
    container.querySelector<HTMLButtonElement>(".peer-list-toggle")!.click();
    expect(container.querySelectorAll(".peer-item")).toHaveLength(7);
    expect(container.querySelector('[data-peer-id="peer-7"]')).toBeNull();
  });

  it("keeps copy-button arrow keys from jumping to an unrelated device", () => {
    document.body.appendChild(container);
    renderPeerList(container, peers, false, false);
    const copy = container.querySelector<HTMLButtonElement>('[data-peer-id="peer-4"] .peer-ip')!;
    copy.focus();
    const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    copy.dispatchEvent(down);
    expect(document.activeElement).toBe(copy);
    expect(down.defaultPrevented).toBe(false);

    const row = container.querySelector<HTMLButtonElement>('[data-peer-id="peer-4"] .peer-item')!;
    row.focus();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(container.querySelector('[data-peer-id="peer-5"] .peer-item'));
  });

  it("matches IPv6 addresses without case sensitivity", () => {
    const peer = makePeer({ tailscaleIPs: ["fd7a:115c:a1e0::ABCD"] });
    expect(filterPeers([peer], " abcd ")).toEqual([peer]);
  });

  it("updates a renamed peer in place, preserving the element", () => {
    const peer = makePeer({ dnsName: "old-name.example.ts.net.", online: true });
    renderPeerList(container, [peer], false, false);
    const before = container.querySelector(".peer-item-container");

    updatePeerList(container, [{ ...peer, dnsName: "new-name.example.ts.net." }], false, false);

    const after = container.querySelector(".peer-item-container");
    expect(after).toBe(before);
    expect(after?.querySelector(".peer-name")?.textContent).toBe("new-name");
  });

  it("rebuilds the item so the Open button appears when a peer comes online", () => {
    const peer = makePeer({ online: false, lastSeen: null });
    renderPeerList(container, [peer], false, false);
    expect(actionLabels(container)).not.toContain("Open");

    updatePeerList(container, [{ ...peer, online: true }], false, false);

    expect(actionLabels(container)).toContain("Open");
  });

  it("rebuilds the item so the Open button disappears when a peer goes offline", () => {
    const peer = makePeer({ online: true });
    renderPeerList(container, [peer], false, false);
    expect(actionLabels(container)).toContain("Open");

    updatePeerList(container, [{ ...peer, online: false, lastSeen: null }], false, false);

    expect(actionLabels(container)).not.toContain("Open");
  });

  it("rebuilds the item so Copy DNS appears when a DNS name shows up later", () => {
    const peer = makePeer({ dnsName: "", online: true });
    renderPeerList(container, [peer], false, false);
    expect(actionLabels(container)).not.toContain("Copy DNS");

    updatePeerList(container, [{ ...peer, dnsName: "router.example.ts.net." }], false, false);

    expect(actionLabels(container)).toContain("Copy DNS");
  });
});
