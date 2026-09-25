// Adapted from Ender-Wang's cross-browser regression test in PR #136.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { waitForPopup } from "../assertions.mjs";
import {
  expectedHostVersion,
  makeControl,
  makeExitNodePeer,
  makeRunningState,
} from "../fixtures.mjs";
import {
  createRoutingNetwork,
  createRoutingTLS,
  proxyCredentials,
  routingTestHost,
} from "../network-fixture.mjs";

const fixtureFirefoxId = "cross-extension-request@tailchrome.test";
const fixtureFirefoxUuid = "7e06f5d8-cf9c-46d3-99b6-a296382e8395";
const fixtureDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/cross-extension-request",
);

export const suite = "smoke";
export const browsers = ["firefox"];
export const launchOptions = {
  additionalExtensionDirs: [fixtureDir],
  additionalFirefoxExtensionUuids: {
    [fixtureFirefoxId]: fixtureFirefoxUuid,
  },
  // Only this scenario accepts the local origin's temporary certificate.
  acceptInsecureCerts: true,
  firefoxPrefs: { "network.dns.localDomains": routingTestHost },
};

export const control = () => {
  const exitNode = makeExitNodePeer({ exitNode: true });
  const running = makeRunningState();
  return makeControl({
    allowRuntimeUpdates: true,
    proxyAuth: proxyCredentials,
    status: makeRunningState({
      exitNode,
      prefs: { ...running.prefs, exitNodeID: exitNode.id },
    }),
  });
};

async function fetchFromExtension(page, url) {
  return page.evaluate(async (target) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetch(target, {
        cache: "no-store",
        signal: controller.signal,
      });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      return { error: String(error) };
    } finally {
      clearTimeout(timeout);
    }
  }, url);
}

export async function run({ browser, openPopup }) {
  const network = await createRoutingNetwork({ tls: createRoutingTLS() });
  let popup;
  let fixture;
  try {
    popup = await openPopup();
    await waitForPopup(popup);
    await popup.evaluate(() => {
      const port = chrome.runtime.connect({ name: "popup" });
      window.proxyAuthTestPort = port;
      port.onMessage.addListener((message) => {
        if (message.type === "state") window.proxyAuthTestState = message.state;
      });
    });
    await popup.evaluate(
      (update) => chrome.runtime.sendMessage({ tailchromeE2ENative: update }),
      {
        control: { proxyPort: network.proxyPort },
        reply: {
          procRunning: {
            port: network.proxyPort,
            pid: 1,
            version: expectedHostVersion,
            proxyAuth: proxyCredentials,
          },
        },
      },
    );
    await popup.waitForFunction(
      (port) => window.proxyAuthTestState?.proxyPort === port &&
        window.proxyAuthTestState?.routingHealth?.status === "active",
      { timeout: 10_000 },
      network.proxyPort,
    );

    fixture = await browser.newPage();
    try {
      await fixture.goto(
        `moz-extension://${fixtureFirefoxUuid}/runner.html`,
        { waitUntil: "domcontentloaded", timeout: 5_000 },
      );
    } catch (error) {
      if (error?.name !== "TimeoutError") throw error;
      const title = await fixture.evaluate(() => document.title).catch(() => "");
      if (title !== "Cross-extension request fixture") throw error;
    }
    // The second extension has neither proxy credentials nor an auth listener.
    // Its first HTTPS request must use Tailchrome's authenticated SOCKS route.
    const path = "/cross-extension";
    const result = await fetchFromExtension(fixture, network.baseURL + path);
    assert.deepEqual(result, { status: 200, body: "routing origin reached" });
    const hits = network.hits.filter((hit) => hit.path === path);
    assert.ok(hits.length > 0, "The origin saw no cross-extension request");
    assert.ok(
      hits.every((hit) => hit.proxied),
      `The second extension bypassed the authenticated proxy: ${JSON.stringify(hits)}`,
    );
  } finally {
    await fixture?.close();
    await popup?.close();
    await network.close();
  }
}
