import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makePeer } from "../../__test__/fixtures";
import { formatRelativeTime, peerDisplayKey } from "./peer-item";

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
