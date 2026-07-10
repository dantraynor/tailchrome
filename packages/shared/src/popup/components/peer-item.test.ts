// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makePeer } from "../../__test__/fixtures";
import {
  createPeerItem,
  formatRelativeTime,
  peerActionsKey,
  peerDisplayKey,
  updatePeerItemText,
} from "./peer-item";

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'offline' for null", () => {
    expect(formatRelativeTime(null)).toBe("offline");
  });

  it("returns 'offline' for invalid date string", () => {
    expect(formatRelativeTime("not-a-date")).toBe("offline");
  });

  it("returns 'offline' for empty string", () => {
    expect(formatRelativeTime("")).toBe("offline");
  });

  it("returns 'just now' for future date", () => {
    expect(formatRelativeTime("2025-06-15T13:00:00Z")).toBe("just now");
  });

  it("returns 'just now' for < 60 seconds ago", () => {
    expect(formatRelativeTime("2025-06-15T11:59:30Z")).toBe("just now");
  });

  it("returns 'just now' at exactly 59 seconds ago", () => {
    expect(formatRelativeTime("2025-06-15T11:59:01Z")).toBe("just now");
  });

  it("returns '1m ago' at exactly 60 seconds", () => {
    expect(formatRelativeTime("2025-06-15T11:59:00Z")).toBe("1m ago");
  });

  it("returns minutes for < 60 minutes", () => {
    expect(formatRelativeTime("2025-06-15T11:30:00Z")).toBe("30m ago");
  });

  it("returns '59m ago' at 59 minutes", () => {
    expect(formatRelativeTime("2025-06-15T11:01:00Z")).toBe("59m ago");
  });

  it("returns '1h ago' at exactly 60 minutes", () => {
    expect(formatRelativeTime("2025-06-15T11:00:00Z")).toBe("1h ago");
  });

  it("returns hours for < 24 hours", () => {
    expect(formatRelativeTime("2025-06-15T06:00:00Z")).toBe("6h ago");
  });

  it("returns '1d ago' at exactly 24 hours", () => {
    expect(formatRelativeTime("2025-06-14T12:00:00Z")).toBe("1d ago");
  });

  it("returns days for < 30 days", () => {
    expect(formatRelativeTime("2025-06-01T12:00:00Z")).toBe("14d ago");
  });

  it("returns '1mo ago' at 30 days", () => {
    expect(formatRelativeTime("2025-05-16T12:00:00Z")).toBe("1mo ago");
  });

  it("returns months for < 12 months", () => {
    expect(formatRelativeTime("2025-01-15T12:00:00Z")).toBe("5mo ago");
  });

  it("returns 'long ago' for > 12 months", () => {
    expect(formatRelativeTime("2024-01-01T00:00:00Z")).toBe("long ago");
  });
});

describe("peerDisplayKey", () => {
  it("changes when the rendered user identity changes", () => {
    const a = makePeer({ userLoginName: "alice@example.com", userName: "Alice" });
    const b = makePeer({ userLoginName: "bob@example.com", userName: "Bob" });

    expect(peerDisplayKey(a)).not.toBe(peerDisplayKey(b));
  });

  it("changes when rx/tx bytes change", () => {
    const a = makePeer({ rxBytes: 100, txBytes: 200 });
    const b = makePeer({ rxBytes: 300, txBytes: 400 });
    expect(peerDisplayKey(a)).not.toBe(peerDisplayKey(b));
  });

  it("changes when tags change", () => {
    const a = makePeer({ tags: ["tag:server"] });
    const b = makePeer({ tags: ["tag:server", "tag:prod"] });
    expect(peerDisplayKey(a)).not.toBe(peerDisplayKey(b));
  });

  it("changes when lastHandshake changes", () => {
    const a = makePeer({ lastHandshake: "2025-01-01T00:00:00Z" });
    const b = makePeer({ lastHandshake: "2025-06-01T00:00:00Z" });
    expect(peerDisplayKey(a)).not.toBe(peerDisplayKey(b));
  });

  it("is stable for identical peers", () => {
    const p = makePeer();
    expect(peerDisplayKey(p)).toBe(peerDisplayKey(p));
  });
});

describe("peerActionsKey", () => {
  it("is stable across a pure rename", () => {
    const peer = makePeer({ dnsName: "a.example.ts.net.", online: true });
    expect(peerActionsKey({ ...peer, dnsName: "b.example.ts.net." }, false, false)).toBe(
      peerActionsKey(peer, false, false),
    );
  });

  it("changes when a field that adds or removes an action changes", () => {
    const peer = makePeer({ dnsName: "a.example.ts.net.", online: true, taildropTarget: false });
    const base = peerActionsKey(peer, false, false);

    expect(peerActionsKey({ ...peer, online: false }, false, false)).not.toBe(base);
    expect(peerActionsKey({ ...peer, dnsName: "" }, false, false)).not.toBe(base);
    expect(peerActionsKey({ ...peer, taildropTarget: true }, false, false)).not.toBe(base);
    expect(peerActionsKey(peer, true, false)).not.toBe(base);
    expect(peerActionsKey({ ...peer, sshHost: true }, false, true)).not.toBe(base);
  });
});

describe("createPeerItem", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the machine name from the DNS name", () => {
    const peer = makePeer({
      hostname: "os-host",
      dnsName: "renamed-laptop.example.ts.net.",
    });

    const item = createPeerItem(peer, false, false);

    expect(item.querySelector(".peer-name")?.textContent).toBe("renamed-laptop");
  });

  it("SSH action uses the new machine name after an in-place rename update", () => {
    const tabsCreate = vi
      .spyOn(chrome.tabs, "create")
      .mockImplementation(() => Promise.resolve());
    const peer = makePeer({
      hostname: "os-host",
      dnsName: "old-name.example.ts.net.",
      sshHost: true,
      online: true,
    });

    const item = createPeerItem(peer, false, true);
    updatePeerItemText(item, { ...peer, dnsName: "new-name.example.ts.net." });

    expect(item.querySelector(".peer-name")?.textContent).toBe("new-name");

    const sshBtn = Array.from(
      item.querySelectorAll<HTMLButtonElement>(".peer-action-btn"),
    ).find((btn) => btn.textContent === "SSH");
    expect(sshBtn).toBeDefined();
    sshBtn!.click();

    expect(tabsCreate).toHaveBeenCalledWith({
      url: "http://100.100.100.100/ssh/new-name",
    });
  });

  it("Open and Copy DNS use the new DNS name after an in-place rename update", () => {
    const tabsCreate = vi
      .spyOn(chrome.tabs, "create")
      .mockImplementation(() => Promise.resolve());
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const peer = makePeer({
      hostname: "os-host",
      dnsName: "old-name.example.ts.net.",
      online: true,
    });

    const item = createPeerItem(peer, false, false);
    updatePeerItemText(item, { ...peer, dnsName: "new-name.example.ts.net." });

    const buttons = Array.from(
      item.querySelectorAll<HTMLButtonElement>(".peer-action-btn"),
    );
    buttons.find((btn) => btn.textContent === "Copy DNS")!.click();
    buttons.find((btn) => btn.textContent === "Open")!.click();

    expect(writeText).toHaveBeenCalledWith("new-name.example.ts.net");
    expect(tabsCreate).toHaveBeenCalledWith({
      url: "http://new-name.example.ts.net/",
    });
  });

  it("Send File toast uses the new machine name after an in-place rename update", async () => {
    const peer = makePeer({
      hostname: "os-host",
      dnsName: "old-name.example.ts.net.",
      taildropTarget: true,
      online: true,
    });

    const item = createPeerItem(peer, false, false);
    updatePeerItemText(item, { ...peer, dnsName: "new-name.example.ts.net." });

    const sendBtn = Array.from(
      item.querySelectorAll<HTMLButtonElement>(".peer-action-btn"),
    ).find((btn) => btn.textContent === "Send File");
    expect(sendBtn).toBeDefined();
    sendBtn!.click();

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    Object.defineProperty(input!, "files", {
      value: [new File(["hello"], "notes.txt", { type: "text/plain" })],
      configurable: true,
    });
    input!.dispatchEvent(new Event("change"));

    await vi.waitFor(() => {
      expect(document.querySelector(".toast")?.textContent).toBe(
        'Sending "notes.txt" to new-name...',
      );
    });
  });
});
