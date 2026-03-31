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
    connect: (_connectInfo?: unknown) => {
      return {
        postMessage: (_msg: unknown) => {},
        disconnect: () => {},
        onMessage: {
          addListener: (_fn: (msg: unknown) => void) => {},
        },
        onDisconnect: {
          addListener: (_fn: (port: unknown) => void) => {},
        },
        name: "popup",
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

// Minimal document mock for popup module imports (top-level readyState check).
// Only installed when document is not already defined (i.e. not in a real DOM env).
if (typeof globalThis.document === "undefined") {
  const listeners: Record<string, Array<() => void>> = {};
  Object.defineProperty(globalThis, "document", {
    value: {
      readyState: "complete",
      addEventListener: (event: string, fn: () => void) => {
        (listeners[event] ??= []).push(fn);
      },
      getElementById: (_id: string) => null,
      querySelector: (_sel: string) => null,
      createElement: (tag: string) => {
        const el: Record<string, unknown> = {
          tagName: tag.toUpperCase(),
          className: "",
          textContent: "",
          style: {},
          children: [] as unknown[],
          innerHTML: "",
          appendChild: (child: unknown) => {
            (el.children as unknown[]).push(child);
            // For escapeHTML: textNode → innerHTML
            if (typeof (child as { textContent?: string }).textContent === "string") {
              el.innerHTML = (child as { textContent: string }).textContent
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;");
            }
            return child;
          },
          setAttribute: () => {},
          addEventListener: () => {},
        };
        return el;
      },
      createTextNode: (text: string) => ({ textContent: text }),
      body: {
        appendChild: () => {},
        removeChild: () => {},
      },
    },
    writable: true,
    configurable: true,
  });
}
