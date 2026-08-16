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
import { expectedHostVersion } from "./fixtures.mjs";

export function createNativeHost(browserName, control, { enabled = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tailchrome-e2e-"));
  const requests = [];
  let server;
  let baseUrl = "";
  if (!enabled) {
    control = {
      ...(control ?? {}),
      nativeFailure: "unavailable",
      nativeFailureMessage:
        browserName === "firefox"
          ? "No such native application tailscale.browser.ext"
          : "Specified native messaging host not found.",
    };
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

  const commandReplyIndexes = Object.create(null);
  let connectionAttempt = 0;
  let manualRecoveryRequested = false;

  // The incompatible kind is intentionally defensive-only in production until
  // a future protocol supplies explicit evidence. Transform background state
  // only inside this fixture so both browser families still exercise that UI.
  if (control.popupFailureKind) {
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== "popup") return;
      const postMessage = port.postMessage.bind(port);
      port.postMessage = (message) => {
        if (message?.type !== "state") {
          postMessage(message);
          return;
        }
        postMessage({
          ...message,
          state: {
            ...message.state,
            hostConnected: false,
            initialized: false,
            proxyEnabled: false,
            helperFailure: {
              kind: control.popupFailureKind,
              diagnosticCode:
                control.popupFailureCode ?? "fixture-explicit-helper-failure",
              diagnosticMessage: null,
            },
          },
        });
      };
    });
  }

  if (control.recoverOnManualRetry) {
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== "popup") return;
      port.onMessage.addListener((message) => {
        if (
          message?.type === "retry-native-host" &&
          message.source === "manual"
        ) {
          manualRecoveryRequested = true;
        }
      });
    });
  }

  function failureMessage(kind) {
    if (control.nativeFailureMessage) return control.nativeFailureMessage;
    switch (kind) {
      case "unavailable":
        return "Specified native messaging host not found.";
      case "not-allowed":
        return "Access to the specified native messaging host is forbidden.";
      case "start-failed":
      case "connect-throw":
      case "init-throw":
        return "The native helper could not start.";
      case "stopped":
        return "The native helper stopped unexpectedly.";
      default:
        return "";
    }
  }

  function replyForRequest(request, c) {
    const scripted = c.commandReplies?.[request.cmd];
    if (scripted !== undefined) {
      if (Array.isArray(scripted)) {
        const index = commandReplyIndexes[request.cmd] ?? 0;
        commandReplyIndexes[request.cmd] = index + 1;
        return scripted[Math.min(index, scripted.length - 1)] ?? null;
      }
      return scripted;
    }
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
            body: "Netcheck is not available in the browser helper; use the Tailscale CLI on a full install.",
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
    connectionAttempt += 1;
    const failureAttempts = Number.isInteger(control.failureAttempts)
      ? control.failureAttempts
      : Number.MAX_SAFE_INTEGER;
    const failureActive =
      Boolean(control.nativeFailure) &&
      connectionAttempt <= failureAttempts &&
      (!control.recoverOnManualRetry || !manualRecoveryRequested);
    if (failureActive && control.nativeFailure === "connect-throw") {
      throw new Error(failureMessage(control.nativeFailure));
    }

    const onMessage = makeEvent();
    const onDisconnect = makeEvent();
    const port = {
      name: "tailchrome-e2e-native-host",
      onMessage,
      onDisconnect,
      error: undefined,
      postMessage(msg) {
        if (
          failureActive &&
          control.nativeFailure === "init-throw" &&
          msg.cmd === "init"
        ) {
          throw new Error(failureMessage(control.nativeFailure));
        }
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
      if (
        failureActive &&
        (control.nativeFailure === "unavailable" ||
          control.nativeFailure === "not-allowed" ||
          control.nativeFailure === "start-failed")
      ) {
        port.error = { message: failureMessage(control.nativeFailure) };
        onDisconnect.dispatch(port);
        return;
      }
      onMessage.dispatch({
        procRunning: {
          port: control.proxyPort ?? 1055,
          pid: 1,
          version: control.hostVersion ?? ${JSON.stringify(expectedHostVersion)},
          ...(typeof control.startupError === "string"
            ? { error: control.startupError }
            : {}),
          supportsNetcheck: control.supportsNetcheck === true,
          supportsPingPeer: control.supportsPingPeer !== false,
          supportsLogin: control.supportsLogin !== false,
          supportsCustomControlURL: control.supportsCustomControlURL !== false,
        },
      });
      if (failureActive && control.nativeFailure === "stopped") {
        queueMicrotask(() => {
          port.error = { message: failureMessage(control.nativeFailure) };
          onDisconnect.dispatch(port);
        });
      }
    });

    return port;
  };
})();
`;
}
