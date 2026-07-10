// Chrome and Firefox only load a non-persistent background at browser launch
// when a runtime.onStartup listener is registered; without one, nothing runs
// until the popup wakes the background, so auto-connect never fires (#90).
// MUST be called synchronously at background top-level — a registration
// deferred past an await is not recorded for the next launch.
//
// The listener body is intentionally empty: waking the background evaluates
// the entry module, and the entry point's init connects the native host and
// runs the auto-connect flow.
export function registerStartupWakeListener(): void {
  const onStartup = chrome.runtime.onStartup as
    | typeof chrome.runtime.onStartup
    | undefined;
  if (!onStartup) {
    // Don't let a missing API silently reintroduce #90 — leave a trace.
    console.warn(
      "[Background] runtime.onStartup unavailable; background will not wake at browser launch",
    );
    return;
  }
  onStartup.addListener(() => {});
}
