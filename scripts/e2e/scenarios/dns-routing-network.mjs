import assert from "node:assert/strict";
import { waitForPopup } from "../assertions.mjs";
import { makeControl, makeRunningState, expectedHostVersion } from "../fixtures.mjs";
import { createRoutingNetwork, routingTestHost, proxyCredentials } from "../network-fixture.mjs";

export const suite = "smoke";
export const browsers = ["chrome", "firefox"];
export const launchOptions = {
  chromeArgs: [`--host-resolver-rules=MAP ${routingTestHost} 127.0.0.1`],
  firefoxPrefs: { "network.dns.localDomains": routingTestHost },
};
export const control = () => makeControl({ allowRuntimeUpdates: true, proxyAuth: proxyCredentials });

export async function run({ browser, openPopup }) {
  const network = await createRoutingNetwork();
  let popup;
  try {
    popup = await openPopup();
    await waitForPopup(popup);
    await popup.evaluate(() => {
      const port = chrome.runtime.connect({ name: "popup" });
      window.dnsTestPort = port;
      port.onMessage.addListener((message) => {
        if (message.type === "state") window.dnsTestState = message.state;
      });
    });
    const wait = async (expectedMode, present) => popup.waitForFunction((mode, hasRoute) => {
      const state = window.dnsTestState;
      return state?.routingPolicy?.mode === mode &&
        state.routingPolicy.dnsRoutes.includes("tailchrome.test") === hasRoute &&
        (mode === "blocked" || state.routingHealth?.status === "active");
    }, { timeout: 10_000 }, expectedMode, present);
    const update = async (value) => popup.evaluate(
      (message) => chrome.runtime.sendMessage({ tailchromeE2ENative: message }), value,
    );
    const navigate = async (path, expected) => {
      const page = await browser.newPage();
      let response;
      let error;
      try {
        response = await page.goto(network.baseURL + path, { waitUntil: "domcontentloaded", timeout: 4_000 });
      } catch (err) {
        error = err;
      } finally {
        await page.close();
      }
      const hits = network.hits.filter((hit) => hit.path === path);
      if (expected === "blocked") {
        assert.equal(hits.length, 0, `Protected DNS request reached the origin: ${JSON.stringify(hits)}`);
        assert.ok(error || !response?.ok(), `Blocked DNS request ${path} succeeded`);
      } else {
        if (error) throw error;
        assert.equal(response?.status(), 200);
        assert.ok(hits.length > 0);
        assert.ok(hits.every((hit) => hit.proxied === (expected === "proxy")), `Wrong route: ${JSON.stringify(hits)}`);
      }
    };

    await wait("active", false);
    await navigate("/dns-direct-control", "direct");
    await update({
      control: { proxyPort: network.proxyPort },
      reply: { procRunning: { port: network.proxyPort, pid: 1, version: expectedHostVersion, proxyAuth: proxyCredentials } },
    });
    const state = makeRunningState({ dnsRoutes: ["tailchrome.test"] });
    await update({ reply: { status: state } });
    await wait("active", true);
    await navigate("/dns-route-proxy", "proxy");

    const { dnsRoutes, ...unknown } = state;
    await update({ reply: { status: unknown } });
    await wait("active", true);
    await navigate("/dns-unknown-keeps-proxy", "proxy");
    await update({ reply: { status: { ...state, dnsRoutes: [] } } });
    await wait("active", false);
    await navigate("/dns-cleared-direct", "direct");

    await update({ reply: { status: state } });
    await wait("active", true);
    await update({ control: { nativeFailure: "unavailable" }, disconnect: true });
    await wait("blocked", true);
    await navigate("/dns-helper-disconnected", "blocked");
  } finally {
    await popup?.close();
    await network.close();
  }
}
