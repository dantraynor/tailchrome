import { afterEach, describe, expect, it, vi } from "vitest";
import { registerStartupWakeListener } from "./startup-wake";

// onStartup is not part of the shared chrome mock; tests add it per case.
const runtime = (
  globalThis.chrome as unknown as { runtime: Record<string, unknown> }
).runtime;

describe("registerStartupWakeListener", () => {
  afterEach(() => {
    delete runtime["onStartup"];
    vi.restoreAllMocks();
  });

  it("registers an onStartup listener so the background wakes at browser launch", () => {
    const addListener = vi.fn();
    runtime["onStartup"] = { addListener };

    registerStartupWakeListener();

    expect(addListener).toHaveBeenCalledTimes(1);
    expect(addListener).toHaveBeenCalledWith(expect.any(Function));
  });

  it("warns instead of throwing when runtime.onStartup is unavailable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => registerStartupWakeListener()).not.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
  });
});
