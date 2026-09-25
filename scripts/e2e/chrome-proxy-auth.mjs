#!/usr/bin/env node
// Cross-extension HTTPS regression for #134. Run after build:chrome.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer";
import { createNativeHost } from "./native-host.mjs";
import { createRoutingNetwork, createRoutingTLS, proxyCredentials } from "./network-fixture.mjs";
import { makeControl, makeRunningState, expectedHostVersion } from "./fixtures.mjs";

const root = mkdtempSync(join(tmpdir(), "tailchrome-cross-extension-auth-"));
let browser;
let native;
const networks = [];
try {
  const tls = createRoutingTLS();
  networks.push(await createRoutingNetwork({ tls }));
  native = createNativeHost("chrome", makeControl({
    allowRuntimeUpdates: true,
    proxyPort: networks[0].proxyPort,
    proxyAuth: proxyCredentials,
    status: makeRunningState({ dnsRoutes: ["tailchrome.test"] }),
  }));
  const extensionDir = await native.prepareExtension(resolve("packages/extension/.output/chrome-mv3"));
  const clientDir = join(root, "client");
  mkdirSync(clientDir);
  writeFileSync(join(clientDir, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "HTTPS API client fixture", version: "1.0",
    host_permissions: ["<all_urls>"], background: { service_worker: "worker.js" },
  }));
  writeFileSync(join(clientDir, "worker.js"), "chrome.runtime.onInstalled.addListener(() => {});");
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BINARY || await puppeteer.executablePath(),
    headless: true,
    enableExtensions: [extensionDir],
    // Only local fixture services are contacted. The origin uses a temporary
    // self-signed certificate; the .test name has no direct DNS resolution.
    args: ["--ignore-certificate-errors", ...(process.env.CI === "true" ? ["--no-sandbox"] : [])],
  });
  const { chromeExtensionId } = JSON.parse(readFileSync("config/extension-ids.json", "utf8"));
  const clientId = await browser.installExtension(clientDir);
  const client = await (await browser.waitForTarget(t => t.type() === "service_worker" && t.url().includes(clientId))).worker();
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${chromeExtensionId}/popup.html`);
  await popup.evaluate(() => {
    const port = chrome.runtime.connect({ name: "popup" });
    globalThis.testPort = port;
    port.onMessage.addListener(msg => { if (msg.type === "state") globalThis.testState = msg.state; });
  });
  const waitForReady = port => popup.waitForFunction(expected => globalThis.testState?.proxyPort === expected && globalThis.testState?.routingHealth?.status === "active", { timeout: 10_000 }, port);
  const request = async (network, path) => {
    const result = await client.evaluate(async url => {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return { status: response.status, body: await response.text() };
    }, network.baseURL + path);
    assert.equal(result.status, 200, `Other extension's HTTPS request failed: ${JSON.stringify(result)}`);
    assert.equal(result.body, "routing origin reached");
    assert.ok(network.hits.some(hit => hit.path === path && hit.proxied));
  };
  await waitForReady(networks[0].proxyPort);
  // The client extension makes the first HTTPS request, with no user browsing
  // to fill the auth cache and no authentication listener in the client.
  await request(networks[0], "/first-extension-request");
  // v0.1.14 authenticates the probe but rejects its reserved destination.
  // Confirm Chrome also retains credentials from that error response.
  networks.push(await createRoutingNetwork({ tls, probeStatus: 502 }));
  await popup.evaluate(({ port, auth, version }) => chrome.runtime.sendMessage({ tailchromeE2ENative: {
    control: { proxyPort: port },
    reply: { procRunning: { port, pid: 2, version, proxyAuth: auth } },
  } }), { port: networks[1].proxyPort, auth: proxyCredentials, version: expectedHostVersion });
  await waitForReady(networks[1].proxyPort);
  await request(networks[1], "/after-helper-restart");
  console.log("PASS: cross-extension HTTPS authenticates before browsing and after helper restart");
} finally {
  await browser?.close();
  native?.cleanup();
  for (const network of networks) await network.close();
  rmSync(root, { recursive: true, force: true });
}
