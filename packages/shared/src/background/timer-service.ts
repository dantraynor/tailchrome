/**
 * Abstraction over setTimeout/setInterval that allows browser-specific
 * implementations (e.g. browser.alarms on Firefox) to survive event page
 * suspension.
 */

export interface TimerService {
  /** Create a repeating timer identified by name. */
  setInterval(name: string, callback: () => void, intervalMs: number): void;
  /** Create a one-shot timer identified by name. */
  setTimeout(name: string, callback: () => void, delayMs: number): void;
  /** Cancel a timer by name. */
  clear(name: string): void;
}

interface TimerEntry {
  id: ReturnType<typeof globalThis.setTimeout>;
  type: "interval" | "timeout";
}

/**
 * Default implementation using native setTimeout/setInterval.
 * Suitable for Chrome service workers and any context where the JS runtime
 * is expected to stay alive while timers are active.
 */
export class DefaultTimerService implements TimerService {
  private timers = new Map<string, TimerEntry>();

  setInterval(name: string, callback: () => void, intervalMs: number): void {
    this.clear(name);
    const id = globalThis.setInterval(callback, intervalMs);
    this.timers.set(name, { id, type: "interval" });
  }

  setTimeout(name: string, callback: () => void, delayMs: number): void {
    this.clear(name);
    const id = globalThis.setTimeout(() => {
      this.timers.delete(name);
      callback();
    }, delayMs);
    this.timers.set(name, { id, type: "timeout" });
  }

  clear(name: string): void {
    const entry = this.timers.get(name);
    if (!entry) return;
    if (entry.type === "interval") {
      globalThis.clearInterval(entry.id);
    } else {
      globalThis.clearTimeout(entry.id);
    }
    this.timers.delete(name);
  }
}
