import { DefaultTimerService, type TimerService } from "./timer-service";

const ALARM_PREFIX = "tailchrome-timer:";

/**
 * Uses a browser alarm as a durable backup for one-shot timers. The native
 * timer preserves sub-minute precision while the alarm can wake a suspended
 * MV3 service worker for longer reconnect delays.
 */
export class ChromeAlarmTimerService implements TimerService {
  private readonly fallback = new DefaultTimerService();
  private readonly timeouts = new Map<string, () => void>();

  constructor() {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (!alarm.name.startsWith(ALARM_PREFIX)) return;
      this.fire(alarm.name.slice(ALARM_PREFIX.length));
    });
  }

  setInterval(name: string, callback: () => void, intervalMs: number): void {
    this.clear(name);
    this.fallback.setInterval(name, callback, intervalMs);
  }

  setTimeout(name: string, callback: () => void, delayMs: number): void {
    this.clear(name);
    this.timeouts.set(name, callback);
    this.fallback.setTimeout(name, () => this.fire(name), delayMs);
    chrome.alarms.create(ALARM_PREFIX + name, {
      when: Date.now() + delayMs,
    });
  }

  clear(name: string): void {
    this.fallback.clear(name);
    this.timeouts.delete(name);
    void chrome.alarms.clear(ALARM_PREFIX + name);
  }

  private fire(name: string): void {
    const callback = this.timeouts.get(name);
    if (!callback) return;
    this.fallback.clear(name);
    this.timeouts.delete(name);
    void chrome.alarms.clear(ALARM_PREFIX + name);
    callback();
  }
}
