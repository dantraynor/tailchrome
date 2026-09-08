import { describe, expect, it } from "vitest";
import { ProxySession, readProxySession } from "./proxy-session";
import type { NativeReply } from "../types";

const auth = { version: 1 as const, username: "tailchrome", password: "a".repeat(52) };

describe("proxy credentials", () => {
  it("rejects missing capability, invalid ports and malformed credentials", () => {
    for (const reply of [
      { port: 1055, pid: 1 },
      { port: 0, pid: 1, proxyAuth: auth },
      { port: 65536, pid: 1, proxyAuth: auth },
      { port: 1.5, pid: 1, proxyAuth: auth },
      { port: 1055, pid: 1, proxyAuth: { ...auth, version: 2 } },
      { port: 1055, pid: 1, proxyAuth: { ...auth, username: "user:password" } },
      { port: 1055, pid: 1, proxyAuth: { ...auth, password: "short" } },
    ]) expect(readProxySession(reply as NonNullable<NativeReply["procRunning"]>)).toBeNull();
  });

  it("keeps credentials private and revokes the old port on replacement and disconnect", () => {
    const session = new ProxySession();
    session.set(readProxySession({ port: 1055, pid: 1, proxyAuth: auth }));
    expect(session.credentialsFor(1055)).toEqual({ username: auth.username, password: auth.password });
    expect(session.credentialsFor(1056)).toBeUndefined();
    expect(JSON.stringify(session)).toBe("{}");
    session.set({ port: 1056, username: "new", password: "b".repeat(52) });
    expect(session.credentialsFor(1055)).toBeUndefined();
    session.set(null);
    expect(session.credentialsFor(1056)).toBeUndefined();
  });
});
