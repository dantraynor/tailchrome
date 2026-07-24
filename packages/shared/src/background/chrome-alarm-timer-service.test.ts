import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChromeAlarmTimerService } from "./chrome-alarm-timer-service";

describe("ChromeAlarmTimerService", () => {
  let alarmListeners: Array<(alarm: chrome.alarms.Alarm) => void>;
  let createAlarm: ReturnType<typeof vi.fn>;
  let clearAlarm: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    alarmListeners = [];
    createAlarm = vi.fn();
    clearAlarm = vi.fn().mockResolvedValue(true);
    chrome.alarms = {
      create: createAlarm,
      clear: clearAlarm,
      onAlarm: {
        addListener: (listener: (alarm: chrome.alarms.Alarm) => void) => {
          alarmListeners.push(listener);
        },
      },
    } as unknown as typeof chrome.alarms;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("backs a reconnect timeout with an alarm that can wake the worker", () => {
    const callback = vi.fn();
    const service = new ChromeAlarmTimerService();

    service.setTimeout("reconnect", callback, 30_000);
    expect(createAlarm).toHaveBeenCalledWith("tailchrome-timer:reconnect", {
      when: Date.now() + 30_000,
    });

    alarmListeners[0]!({ name: "tailchrome-timer:reconnect" } as chrome.alarms.Alarm);
    expect(callback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
