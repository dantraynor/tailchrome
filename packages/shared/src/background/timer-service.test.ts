import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DefaultTimerService } from "./timer-service";

describe("DefaultTimerService", () => {
  let service: DefaultTimerService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new DefaultTimerService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("setInterval", () => {
    it("fires callback repeatedly", () => {
      const cb = vi.fn();
      service.setInterval("poll", cb, 1000);

      vi.advanceTimersByTime(3000);
      expect(cb).toHaveBeenCalledTimes(3);
    });

    it("replaces previous interval with same name", () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      service.setInterval("poll", cb1, 1000);
      service.setInterval("poll", cb2, 1000);

      vi.advanceTimersByTime(1000);
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  describe("setTimeout", () => {
    it("fires callback once", () => {
      const cb = vi.fn();
      service.setTimeout("reconnect", cb, 500);

      vi.advanceTimersByTime(500);
      expect(cb).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(500);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("self-cleans from internal map after firing", () => {
      const cb = vi.fn();
      service.setTimeout("reconnect", cb, 500);

      vi.advanceTimersByTime(500);
      expect(cb).toHaveBeenCalledTimes(1);

      // Clearing after fire should be a no-op (no error)
      service.clear("reconnect");
    });

    it("replaces previous timeout with same name", () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      service.setTimeout("retry", cb1, 500);
      service.setTimeout("retry", cb2, 500);

      vi.advanceTimersByTime(500);
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  describe("clear", () => {
    it("cancels an active interval", () => {
      const cb = vi.fn();
      service.setInterval("poll", cb, 1000);

      vi.advanceTimersByTime(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      service.clear("poll");
      vi.advanceTimersByTime(3000);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("cancels an active timeout", () => {
      const cb = vi.fn();
      service.setTimeout("reconnect", cb, 1000);

      service.clear("reconnect");
      vi.advanceTimersByTime(2000);
      expect(cb).not.toHaveBeenCalled();
    });

    it("is a no-op for unknown name", () => {
      // Should not throw
      service.clear("nonexistent");
    });
  });
});
