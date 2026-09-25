import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeProxyAuth } from "./chrome-proxy-auth";

function challenge(overrides: Record<string, unknown> = {}) {
  return { isProxy: true, challenger: { host: "127.0.0.1", port: 1055 }, requestId: "1", ...overrides } as chrome.webRequest.OnAuthRequiredDetails;
}

describe("Chrome proxy authentication", () => {
  it("responds only to proxy challenges at the current loopback port", () => {
    const auth = new ChromeProxyAuth();
    auth.set({ port: 1055, username: "user", password: "secret" });
    const callback = vi.fn();
    for (const details of [challenge({ isProxy: false }), challenge({ challenger: { host: "evil.example", port: 1055 } }), challenge({ challenger: { host: "127.0.0.1", port: 9999 } })]) {
      auth.listener(details, callback);
      expect(callback).toHaveBeenLastCalledWith({});
    }
    auth.listener(challenge(), callback);
    expect(callback).toHaveBeenLastCalledWith({ authCredentials: { username: "user", password: "secret" } });
    auth.listener(challenge(), callback);
    expect(callback).toHaveBeenLastCalledWith({ cancel: true });
    auth.set(null);
    auth.listener(challenge({ requestId: "2" }), callback);
    expect(callback).toHaveBeenLastCalledWith({});
  });
});


describe("Chrome proxy authentication bootstrap", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  const session = { port: 1055, username: "user", password: "secret" };

  it.each([204, 502])("primes the browser cache with a local request (HTTP %s)", async (status) => {
    const fetch = vi.fn().mockResolvedValue({ status });
    vi.stubGlobal("fetch", fetch);
    const auth = new ChromeProxyAuth();
    auth.set(session);
    expect(auth.isReadyFor(1055)).toBe(false);
    await auth.prepare(1055);
    expect(fetch).toHaveBeenCalledWith("http://tailchrome-proxy-auth.invalid/", expect.objectContaining({ method: "HEAD", credentials: "include", cache: "no-store", redirect: "error" }));
    expect(auth.isReadyFor(1055)).toBe(true);
    expect(auth.isReadyFor(1056)).toBe(false);
    auth.set({ ...session });
    await auth.prepare(1055);
    expect(fetch).toHaveBeenCalledTimes(1);
    auth.set({ ...session, password: "replacement" });
    expect(auth.isReadyFor(1055)).toBe(false);
  });

  it("rejects a proxy authentication failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 407 }));
    const auth = new ChromeProxyAuth();
    auth.set(session);
    await expect(auth.prepare(1055)).rejects.toThrow("Proxy authentication failed");
    expect(auth.isReadyFor(1055)).toBe(false);
  });

  it("does not accept an old response after the helper disconnects", async () => {
    let finish!: (value: { status: number }) => void;
    const fetch = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const auth = new ChromeProxyAuth();
    auth.set(session);
    const pending = auth.prepare(1055);
    auth.set(null);
    finish({ status: 204 });
    await expect(pending).rejects.toThrow();
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(auth.isReadyFor(1055)).toBe(false);
  });

  it("bounds the probe timeout and permits a later retry", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    vi.stubGlobal("fetch", fetch);
    const auth = new ChromeProxyAuth();
    auth.set(session);
    const pending = expect(auth.prepare(1055)).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(auth.isReadyFor(1055)).toBe(false);
    fetch.mockResolvedValue({ status: 204 });
    await auth.prepare(1055);
    expect(auth.isReadyFor(1055)).toBe(true);
  });
});
