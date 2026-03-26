// Minimal browser/chrome API mock for testing Firefox extension background scripts.

type ProxyListener = (details: { url: string }) => unknown;

const listeners: ProxyListener[] = [];

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
