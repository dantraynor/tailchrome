// Minimal chrome API mock for testing extension background scripts.

const chromeMock = {
  proxy: {
    settings: {
      set: (_details: unknown, cb?: () => void) => {
        cb?.();
      },
    },
  },
  runtime: {
    lastError: null as chrome.runtime.LastError | null,
  },
};

Object.defineProperty(globalThis, "chrome", {
  value: chromeMock,
  writable: true,
});
