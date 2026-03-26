// Minimal chrome API mock for testing extension background scripts.

const chromeMock = {
  action: {
    setIcon: (_details: unknown) => Promise.resolve(),
    setBadgeText: (_details: unknown) => {},
    setBadgeBackgroundColor: (_details: unknown) => {},
  },
  proxy: {
    settings: {
      set: (_details: unknown, cb?: () => void) => {
        cb?.();
      },
    },
  },
  runtime: {
    lastError: null as chrome.runtime.LastError | null,
    connectNative: (_id: string) => {
      const messageListeners: Array<(msg: unknown) => void> = [];
      const disconnectListeners: Array<(port: unknown) => void> = [];
      return {
        postMessage: (_msg: unknown) => {},
        disconnect: () => {},
        onMessage: {
          addListener: (fn: (msg: unknown) => void) => {
            messageListeners.push(fn);
          },
          _listeners: messageListeners,
        },
        onDisconnect: {
          addListener: (fn: (port: unknown) => void) => {
            disconnectListeners.push(fn);
          },
          _listeners: disconnectListeners,
        },
      };
    },
    onConnect: {
      addListener: (_fn: (port: unknown) => void) => {},
    },
    onInstalled: {
      addListener: (_fn: () => void) => {},
    },
  },
  storage: {
    local: {
      get: (_key: string) => Promise.resolve({} as Record<string, unknown>),
      set: (_items: Record<string, unknown>) => Promise.resolve(),
      remove: (_key: string) => Promise.resolve(),
    },
  },
  tabs: {
    create: (_opts: unknown) => Promise.resolve(),
  },
  contextMenus: {
    create: (_opts: unknown) => {},
    onClicked: {
      addListener: (_fn: (info: unknown) => void) => {},
    },
  },
};

Object.defineProperty(globalThis, "chrome", {
  value: chromeMock,
  writable: true,
});
