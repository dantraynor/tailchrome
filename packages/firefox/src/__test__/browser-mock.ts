// Minimal browser/chrome API mock for testing Firefox extension background scripts.

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
    create: (_name: string, _info: Record<string, unknown>) => {},
    clear: async (_name: string) => true,
    onAlarm: {
      addListener: (_cb: (alarm: { name: string }) => void) => {},
    },
  },
};

const chromeMock = {
  runtime: {
    lastError: null as { message?: string } | null,
  },
};

Object.defineProperty(globalThis, "browser", {
  value: browserMock,
  writable: true,
});

Object.defineProperty(globalThis, "chrome", {
  value: chromeMock,
  writable: true,
});
