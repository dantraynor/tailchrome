import type { TimerService } from "@tailchrome/shared/background/timer-service";

/**
 * Hybrid TimerService for Firefox MV3 event pages.
 *
 * - setInterval → browser.alarms (survives event page suspension, can wake
 *   the page). Minimum period is ~1 minute in production, which is fine for
 *   keepalive pings.
 *
 * - setTimeout → native setTimeout (fires at the requested delay with no
 *   clamping). One-shot timers like reconnect backoff happen while the page
 *   is already awake. If the page suspends before the timer fires, the fresh
 *   initBackground() on wake handles reconnection from scratch.
 */

declare const browser: {
  alarms: {
    create(name: string, alarmInfo: { delayInMinutes?: number; periodInMinutes?: number }): void;
    clear(name: string): Promise<boolean>;
    onAlarm: {
      addListener(callback: (alarm: { name: string }) => void): void;
    };
  };
};

interface AlarmEntry {
  callback: () => void;
}

interface TimeoutEntry {
  id: ReturnType<typeof globalThis.setTimeout>;
}

export class AlarmsTimerService implements TimerService {
  private alarms = new Map<string, AlarmEntry>();
  private timeouts = new Map<string, TimeoutEntry>();

  constructor() {
    browser.alarms.onAlarm.addListener((alarm) => {
      const entry = this.alarms.get(alarm.name);
      if (!entry) return;
      entry.callback();
    });
  }

  setInterval(name: string, callback: () => void, intervalMs: number): void {
    this.clear(name);
    this.alarms.set(name, { callback });
    browser.alarms.create(name, {
      periodInMinutes: intervalMs / 60_000,
    });
  }

  setTimeout(name: string, callback: () => void, delayMs: number): void {
    this.clear(name);
    const id = globalThis.setTimeout(() => {
      this.timeouts.delete(name);
      callback();
    }, delayMs);
    this.timeouts.set(name, { id });
  }

  clear(name: string): void {
    const alarm = this.alarms.get(name);
    if (alarm) {
      this.alarms.delete(name);
      browser.alarms.clear(name);
    }
    const timeout = this.timeouts.get(name);
    if (timeout) {
      globalThis.clearTimeout(timeout.id);
      this.timeouts.delete(name);
    }
  }
}
