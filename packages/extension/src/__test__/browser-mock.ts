// Minimal browser API mock for testing Firefox extension background scripts.

type ProxyListener = (details: { url: string }) => unknown;

const listeners: ProxyListener[] = [];

// In-memory session storage mock
const sessionStore: Record<string, unknown> = {};

const browserMock = {
  proxy: {
    onRequest: {
      addListener: (listener: ProxyListener, _filter: { urls: string[] }) => {
        listeners.push(listener);
      },
      removeListener: (listener: ProxyListener) => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      },
      hasListener: (listener: ProxyListener) => {
        return listeners.includes(listener);
      },
    },
  },
  storage: {
    session: {
      get: async (key: string) => {
        return key in sessionStore ? { [key]: sessionStore[key] } : {};
      },
      set: async (items: Record<string, unknown>) => {
        Object.assign(sessionStore, items);
      },
      remove: async (key: string) => {
        delete sessionStore[key];
      },
    },
  },
  alarms: {
    create: (_name: string, _info: { periodInMinutes: number }) => {},
    clear: async (_name: string) => true,
    onAlarm: {
      addListener: (_fn: (alarm: { name: string }) => void) => {},
    },
  },
};

Object.defineProperty(globalThis, "browser", {
  value: browserMock,
  writable: true,
  configurable: true,
});

if (typeof globalThis.chrome === "undefined") {
  Object.defineProperty(globalThis, "chrome", {
    value: {
      runtime: {
        lastError: null as { message?: string } | null,
      },
    },
    writable: true,
    configurable: true,
  });
}

/** Reset session storage between tests. */
export function resetSessionStorage(): void {
  for (const key of Object.keys(sessionStore)) {
    delete sessionStore[key];
  }
}
