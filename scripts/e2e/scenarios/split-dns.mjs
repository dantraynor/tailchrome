import assert from "node:assert/strict";
import { createServer } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import { expectText, getProxyConfig, waitForPopup } from "../assertions.mjs";
import { makeControl, makeRunningState } from "../fixtures.mjs";

export const suite = "smoke";
export const browsers = ["chrome"];

export const control = () =>
  makeControl({
    status: makeRunningState({
      exitNode: null,
      splitDNSDomains: ["internal.example.com"],
    }),
  });

// Answer HTTP over SOCKS5 locally, recording the original destination. This
// verifies Chrome delegates DNS to the proxy without contacting any service.
async function startProxy() {
  const requests = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let stage = "greeting";
    let hostname;
    let port;

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "greeting") {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        if (buffer[0] !== 5) return socket.destroy();
        buffer = buffer.subarray(2 + buffer[1]);
        socket.write(Buffer.from([5, 0]));
        stage = "connect";
      }
      if (stage === "connect") {
        if (buffer.length < 5) return;
        // Domain address type proves Chrome did not resolve the name locally.
        if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[3] !== 3) {
          return socket.destroy();
        }
        const length = buffer[4];
        if (buffer.length < 7 + length) return;
        hostname = buffer.subarray(5, 5 + length).toString("utf8");
        port = buffer.readUInt16BE(5 + length);
        buffer = buffer.subarray(7 + length);
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        stage = "http";
      }
      if (stage === "http" && buffer.includes("\r\n\r\n")) {
        const request = buffer.toString("utf8");
        requests.push({ hostname, port, request });
        const body = `split DNS proxy reached: ${hostname}`;
        socket.end(
          "HTTP/1.1 200 OK\r\n" +
            "Content-Type: text/plain\r\n" +
            "Cache-Control: no-store\r\n" +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            "Connection: close\r\n\r\n" +
            body,
        );
        stage = "done";
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function waitForRouting(page, expected) {
  const deadline = Date.now() + 5_000;
  let actual;
  while (Date.now() < deadline) {
    const config = await getProxyConfig(page);
    if (config.mode === "pac_script") {
      const pac = runInNewContext(
        `${config.pacScript.data}; FindProxyForURL;`,
        { dnsDomainIs: (host, suffix) => host.endsWith(suffix) },
      );
      actual = Object.fromEntries(
        Object.keys(expected).map((host) => [host, pac(`http://${host}/`, host)]),
      );
      if (isDeepStrictEqual(actual, expected)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(actual, expected, "Chrome did not refresh split DNS routing");
}

export async function run({ browser, openPopup, control }) {
  const proxy = await startProxy();
  const page = await openPopup();
  const content = await browser.newPage();
  try {
    await waitForPopup(page);
    await expectText(page, "example.ts.net");
    const target = await browser.waitForTarget(
      (candidate) => candidate.type() === "service_worker",
    );
    const worker = await target.worker();
    const sendReply = (reply) =>
      worker.evaluate(
        (message) => globalThis.__tailchromeE2ENativeReply(message),
        reply,
      );
    await sendReply({
      procRunning: {
        port: proxy.port,
        pid: 1,
        version: control.hostVersion,
      },
    });

    const viaProxy = `SOCKS5 127.0.0.1:${proxy.port}`;
    await waitForRouting(page, {
      "internal.example.com": viaProxy,
      "service.internal.example.com": viaProxy,
      "notinternal.example.com": "DIRECT",
      "internal.example.com.public.example": "DIRECT",
      "public.example.com": "DIRECT",
    });

    for (const hostname of [
      "internal.example.com",
      "service.internal.example.com",
    ]) {
      await content.goto(`http://${hostname}:18080/split-dns`, {
        waitUntil: "domcontentloaded",
        timeout: 5_000,
      });
      await expectText(content, `split DNS proxy reached: ${hostname}`);
      assert.ok(
        proxy.requests.some(
          (request) =>
            request.hostname === hostname &&
            request.port === 18080 &&
            request.request.startsWith("GET /split-dns HTTP/1.1"),
        ),
        `Proxy did not receive the unresolved hostname ${hostname}`,
      );
    }

    await sendReply({
      status: {
        ...control.status,
        splitDNSDomains: ["replacement.example.com"],
      },
    });
    await waitForRouting(page, {
      "internal.example.com": "DIRECT",
      "service.internal.example.com": "DIRECT",
      "replacement.example.com": viaProxy,
      "service.replacement.example.com": viaProxy,
    });

    await sendReply({ status: { ...control.status, splitDNSDomains: [] } });
    await waitForRouting(page, {
      "internal.example.com": "DIRECT",
      "service.internal.example.com": "DIRECT",
      "replacement.example.com": "DIRECT",
      "service.replacement.example.com": "DIRECT",
    });
  } finally {
    await content.close();
    await page.close();
    await proxy.close();
  }
}
