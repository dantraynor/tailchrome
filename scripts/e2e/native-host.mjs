import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createNativeHost(_browserName, control, { enabled = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tailchrome-e2e-"));
  const requests = [];
  let server;
  let baseUrl = "";
  if (!enabled) {
    control = { ...(control ?? {}), connectError: "install_error" };
  }

  return {
    root,
    async prepareExtension(extensionDir) {
      baseUrl = await startServer();
      const targetDir = join(root, "extension");
      cpSync(extensionDir, targetDir, { recursive: true });
      patchBackground(targetDir, baseUrl, control ?? {});
      return targetDir;
    },
    clearRequests() {
      requests.length = 0;
    },
    readRequests() {
      return requests.map((msg) => ({
        ts: new Date().toISOString(),
        msg,
      }));
    },
    cleanup() {
      server?.close();
      rmSync(root, { recursive: true, force: true });
    },
  };

  function startServer() {
    return new Promise((resolve, reject) => {
      server = createServer(async (req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "content-type");
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method === "POST" && req.url === "/request") {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks).toString("utf8");
          requests.push(JSON.parse(body));
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        res.writeHead(404);
        res.end("not found");
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }
}

function patchBackground(extensionDir, baseUrl, initialControl) {
  const backgroundPath = join(extensionDir, "background.js");
  if (!existsSync(backgroundPath)) {
    throw new Error(`background.js not found in ${extensionDir}`);
  }

  const original = readFileSync(backgroundPath, "utf8");
  const patched = `${mockSource(baseUrl, initialControl)}\n${original}`;
  copyFileSync(backgroundPath, join(extensionDir, "background.original.js"));
  writeFileSync(backgroundPath, patched);
}

function mockSource(baseUrl, initialControl) {
  return `
(() => {
  const baseUrl = ${JSON.stringify(baseUrl)};
  // Control object is inlined at extension-patch time. Both the startup
  // dispatch and request replies are served from this snapshot so the popup
  // never races against a fetch round-trip and the message sequence is
  // deterministic for every scenario.
  const control = ${JSON.stringify(initialControl)};

  async function logRequest(msg) {
    await fetch(baseUrl + "/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(msg),
    }).catch(() => {});
  }

  function makeEvent() {
    const listeners = new Set();
    return {
      addListener(listener) {
        listeners.add(listener);
      },
      removeListener(listener) {
        listeners.delete(listener);
      },
      dispatch(...args) {
        for (const listener of [...listeners]) listener(...args);
      },
    };
  }

  function defaultProfiles() {
    return {
      current: { id: "profile-default", name: "Default" },
      profiles: [{ id: "profile-default", name: "Default" }],
    };
  }

  function replyForRequest(request, c) {
    switch (request.cmd) {
      case "init":
        return { init: c.init ?? {} };
      case "get-status":
        return c.status ? { status: c.status } : null;
      case "list-profiles":
        return { profiles: c.profiles ?? defaultProfiles() };
      case "login":
        if (c.loginError) {
          return {
            error: {
              cmd: "login",
              message: c.loginError,
            },
          };
        }
        return c.loginStatus ? { status: c.loginStatus } : null;
      case "suggest-exit-node":
        if (c.suggestExitNodeError) {
          return {
            error: {
              cmd: "suggest-exit-node",
              message: c.suggestExitNodeError,
            },
          };
        }
        return c.exitNodeSuggestion
          ? { exitNodeSuggestion: c.exitNodeSuggestion }
          : null;
      case "ping-peer":
        return {
          diagnostic: {
            title: "Ping",
            body: "pong from " + request.nodeID,
          },
        };
      case "netcheck":
        return {
          diagnostic: {
            title: "Netcheck",
            body: "UDP: true\\nIPv4: yes\\nIPv6: no",
          },
        };
      case "send-file":
        return {
          fileSendProgress: {
            targetNodeID: request.nodeID,
            name: request.fileName,
            percent: 100,
            done: true,
            error: c.fileSendError ?? null,
          },
        };
      default:
        return null;
    }
  }

  chrome.runtime.connectNative = function connectNative() {
    const onMessage = makeEvent();
    const onDisconnect = makeEvent();
    const port = {
      name: "tailchrome-e2e-native-host",
      onMessage,
      onDisconnect,
      postMessage(msg) {
        void logRequest(msg);
        queueMicrotask(() => {
          const reply = replyForRequest(msg, control);
          if (reply) onMessage.dispatch(reply);
        });
      },
      disconnect() {
        queueMicrotask(() => onDisconnect.dispatch(port));
      },
    };

    // Dispatch procRunning synchronously from the inlined snapshot so it
    // reaches the background before the popup connects. The fetch
    // round-trip used previously raced with openPopup and left the popup
    // stuck on the skeleton view.
    queueMicrotask(() => {
      if (control.connectError) {
        onMessage.dispatch({
          error: { cmd: "connect", message: control.connectError },
        });
        return;
      }
      onMessage.dispatch({
        procRunning: {
          port: control.proxyPort ?? 1055,
          pid: 1,
          version: control.hostVersion ?? "0.1.12",
          error: control.startupError,
          supportsNetcheck: control.supportsNetcheck !== false,
          supportsPingPeer: control.supportsPingPeer !== false,
          supportsLogin: control.supportsLogin !== false,
          supportsCustomControlURL: control.supportsCustomControlURL !== false,
        },
      });
    });

    return port;
  };
})();
`;
}
