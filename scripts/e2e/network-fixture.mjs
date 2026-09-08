import { createServer as createHTTPServer, request } from "node:http";
import { createServer, createConnection } from "node:net";

export const routingTestHost = "routing.tailchrome.test";
export const proxyCredentials = {
  version: 1,
  username: "fixture",
  password: "fixture-credential-".repeat(3),
};

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

// Real local HTTP and proxy sockets make direct fallback observable. Only this
// fixture's origin is accepted as a proxy destination.
export async function createRoutingNetwork() {
  const hits = [];
  const sockets = new Set();
  const forwardedPorts = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    return socket;
  };
  const origin = createHTTPServer((req, res) => {
    hits.push({
      path: req.url,
      proxied: forwardedPorts.has(req.socket.remotePort) || req.headers["x-tailchrome-test-proxy"] === "yes",
    });
    res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end("routing origin reached");
  });
  origin.on("connection", track);
  const originPort = await listen(origin);
  const baseURL = `http://${routingTestHost}:${originPort}`;
  const allowedTarget = (host, port) => host === routingTestHost && Number(port) === originPort;
  const basic = `Basic ${Buffer.from(`${proxyCredentials.username}:${proxyCredentials.password}`).toString("base64")}`;

  function tunnel(client, head = Buffer.alloc(0)) {
    client.pause();
    const upstream = track(createConnection(originPort, "127.0.0.1"));
    upstream.once("connect", () => {
      const port = upstream.localPort;
      forwardedPorts.add(port);
      upstream.once("close", () => forwardedPorts.delete(port));
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    client.once("close", () => upstream.destroy());
    upstream.once("error", () => client.destroy());
    return upstream;
  }

  const httpProxy = createHTTPServer((req, res) => {
    if (req.headers["proxy-authorization"] !== basic) {
      res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="Tailchrome"' });
      res.end();
      return;
    }
    let url;
    try { url = new URL(req.url); } catch { res.writeHead(400).end(); return; }
    if (!allowedTarget(url.hostname, url.port)) { res.writeHead(403).end(); return; }
    const upstream = request({
      hostname: "127.0.0.1", port: originPort, path: url.pathname + url.search,
      method: req.method,
      headers: { "x-tailchrome-test-proxy": "yes" },
    }, (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on("error", () => { res.writeHead(502).end(); });
    req.pipe(upstream);
  });
  httpProxy.on("connect", (req, client, head) => {
    if (req.headers["proxy-authorization"] !== basic) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Tailchrome"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (req.url !== `${routingTestHost}:${originPort}`) { client.destroy(); return; }
    tunnel(client, head).once("connect", () => client.write("HTTP/1.1 200 Connection Established\r\n\r\n"));
  });

  function socks(client, first) {
    let buffer = first;
    let stage = "hello";
    const receive = (chunk = Buffer.alloc(0)) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (stage === "hello") {
          if (buffer.length < 2 || buffer.length < buffer[1] + 2) return;
          const methods = buffer.subarray(2, buffer[1] + 2);
          const method = methods.includes(2) ? 2 : methods.includes(0) ? 0 : 255;
          buffer = buffer.subarray(buffer[1] + 2);
          client.write(Buffer.from([5, method]));
          if (method === 255) { client.end(); return; }
          stage = method === 2 ? "auth" : "connect";
        } else if (stage === "auth") {
          if (buffer.length < 2 || buffer.length < 3 + buffer[1]) return;
          const passwordOffset = 2 + buffer[1];
          const end = passwordOffset + 1 + buffer[passwordOffset];
          if (buffer.length < end) return;
          const valid = buffer.subarray(2, passwordOffset).toString() === proxyCredentials.username &&
            buffer.subarray(passwordOffset + 1, end).toString() === proxyCredentials.password;
          client.write(Buffer.from([1, valid ? 0 : 1]));
          if (!valid) { client.end(); return; }
          buffer = buffer.subarray(end);
          stage = "connect";
        } else {
          if (buffer.length < 5) return;
          // proxyDNS is enabled in both browsers, so require a domain target.
          if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[3] !== 3) { client.destroy(); return; }
          const end = 5 + buffer[4];
          if (buffer.length < end + 2) return;
          const host = buffer.subarray(5, end).toString();
          if (!allowedTarget(host, buffer.readUInt16BE(end))) { client.destroy(); return; }
          client.removeListener("data", receive);
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          tunnel(client, buffer.subarray(end + 2));
          return;
        }
      }
    };
    client.on("data", receive);
    receive();
  }

  const proxy = createServer((client) => {
    track(client);
    client.once("data", (first) => {
      if (first[0] === 5) socks(client, first);
      else {
        client.pause();
        client.unshift(first);
        httpProxy.emit("connection", client);
        client.resume();
      }
    });
  });
  const proxyPort = await listen(proxy);
  return {
    baseURL, proxyPort, hits,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([origin, proxy].map((server) => new Promise((resolve) => server.close(resolve))));
    },
  };
}
