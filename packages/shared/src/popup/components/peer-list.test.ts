// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { makePeer } from "../../__test__/fixtures";
import { renderPeerList, updatePeerList } from "./peer-list";

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
