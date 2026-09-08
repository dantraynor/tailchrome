import assert from "node:assert/strict";
import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import { expectText, getProxyConfig, waitForPopup } from "../assertions.mjs";
import { makeControl, makeRunningState } from "../fixtures.mjs";
import { proxyCredentials } from "../network-fixture.mjs";

export const suite = "smoke";
export const browsers = ["chrome"];

export const control = () =>
  makeControl({
    allowRuntimeUpdates: true,
    proxyAuth: proxyCredentials,
    status: makeRunningState({
      exitNode: null,
      splitDNSDomains: ["internal.example.com"],
      dnsRoutes: ["internal.example.com"],
    }),
  });

// Answer authenticated HTTP proxy requests locally, recording the original
// destination. Chrome must send the hostname without resolving it locally.
async function startProxy() {
  const requests = [];
  const sockets = new Set();
  const basic = `Basic ${Buffer.from(`${proxyCredentials.username}:${proxyCredentials.password}`).toString("base64")}`;
  const server = createServer((request, response) => {
    if (request.headers["proxy-authorization"] !== basic) {
      response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="Tailchrome"' });
      response.end();
      return;
    }
    let target;
    try {
      target = new URL(request.url);
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (!["internal.example.com", "service.internal.example.com"].includes(target.hostname)) {
      response.writeHead(403).end();
      return;
    }
    requests.push({
      hostname: target.hostname,
      port: Number(target.port),
      method: request.method,
      path: target.pathname,
    });
    response.writeHead(200, {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
      Connection: "close",
    });
    response.end(`split DNS proxy reached: ${target.hostname}`);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
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
    const sendReply = (reply) =>
      page.evaluate(
        (message) => chrome.runtime.sendMessage({ tailchromeE2ENative: { reply: message } }),
        reply,
      );
    await sendReply({
      procRunning: {
        port: proxy.port,
        pid: 1,
        version: control.hostVersion,
        proxyAuth: proxyCredentials,
      },
    });

    const viaProxy = `PROXY 127.0.0.1:${proxy.port}`;
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
            request.method === "GET" &&
            request.path === "/split-dns",
        ),
        `Proxy did not receive the unresolved hostname ${hostname}`,
      );
    }

    await sendReply({
      status: {
        ...control.status,
        splitDNSDomains: ["replacement.example.com"],
        dnsRoutes: ["replacement.example.com"],
      },
    });
    await waitForRouting(page, {
      "internal.example.com": "DIRECT",
      "service.internal.example.com": "DIRECT",
      "replacement.example.com": viaProxy,
      "service.replacement.example.com": viaProxy,
    });

    await sendReply({ status: { ...control.status, splitDNSDomains: [], dnsRoutes: [] } });
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
