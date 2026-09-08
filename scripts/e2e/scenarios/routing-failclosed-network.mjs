import assert from "node:assert/strict";
import { waitForPopup } from "../assertions.mjs";
import { makeControl, makeExitNodePeer, makeRunningState, expectedHostVersion } from "../fixtures.mjs";
import { createRoutingNetwork, routingTestHost, proxyCredentials } from "../network-fixture.mjs";

export const suite = "smoke";
export const browsers = ["chrome", "firefox"];
export const launchOptions = {
  chromeArgs: [`--host-resolver-rules=MAP ${routingTestHost} 127.0.0.1`],
  firefoxPrefs: { "network.dns.localDomains": routingTestHost },
};
export const control = () => makeControl({ allowRuntimeUpdates: true, proxyAuth: proxyCredentials });

async function nativeUpdate(page, update) {
  await page.evaluate((value) => chrome.runtime.sendMessage({ tailchromeE2ENative: value }), update);
}

async function waitForRouting(page, mode, domain) {
  await page.waitForFunction((expectedMode, expectedDomain) => {
    const state = window.routingTestState;
    return state?.routingPolicy?.mode === expectedMode &&
      (expectedMode === "blocked"
        ? ["blocked", "unavailable"].includes(state.routingHealth?.status)
        : state.routingHealth?.status === (expectedMode === "direct" ? "inactive" : expectedMode)) &&
      (expectedDomain === undefined || state.domainSplit.domains.includes(expectedDomain));
  }, { timeout: 10_000 }, mode, domain).catch(async (err) => {
    const state = await page.evaluate(() => ({
      policy: window.routingTestState?.routingPolicy,
      health: window.routingTestState?.routingHealth,
      backend: window.routingTestState?.backendState,
    }));
    throw new Error(`Waiting for ${mode} routing: ${JSON.stringify(state)}`, { cause: err });
  });
}

async function navigate(browser, network, path, { blocked = false, proxied = false } = {}) {
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
  const matching = network.hits.filter((hit) => hit.path === path);
  if (blocked) {
    assert.equal(matching.length, 0, `Protected request ${path} reached the origin: ${JSON.stringify(matching)}`);
    assert.ok(error || !response?.ok(), `Protected navigation ${path} unexpectedly succeeded`);
  } else {
    if (error) throw error;
    assert.equal(response?.status(), 200, `Navigation ${path} did not reach the origin`);
    assert.ok(matching.length > 0, `Origin saw no request for ${path}`);
    assert.ok(matching.every((hit) => hit.proxied === proxied), `Wrong route for ${path}: ${JSON.stringify(matching)}`);
  }
}

export async function run({ browser, openPopup }) {
  const network = await createRoutingNetwork();
  let popup;
  try {
    popup = await openPopup();
    await waitForPopup(popup);
    await popup.evaluate(() => {
      const port = chrome.runtime.connect({ name: "popup" });
      window.routingTestPort = port;
      port.onMessage.addListener((message) => {
        if (message.type === "state") window.routingTestState = message.state;
      });
    });
    await waitForRouting(popup, "active");
    await navigate(browser, network, "/direct-positive-control");

    const exit = makeExitNodePeer({ exitNode: true });
    const running = makeRunningState();
    const selected = makeRunningState({
      exitNode: null,
      prefs: { ...running.prefs, exitNodeID: exit.id },
    });
    await nativeUpdate(popup, { reply: { status: selected } });
    await waitForRouting(popup, "blocked");
    await navigate(browser, network, "/missing-exit", { blocked: true });

    await nativeUpdate(popup, { reply: { status: { ...selected, exitNode: { ...exit, online: false } } } });
    await waitForRouting(popup, "blocked");
    await navigate(browser, network, "/offline-exit", { blocked: true });

    const recovered = { ...selected, exitNode: exit };
    await nativeUpdate(popup, {
      control: { proxyPort: network.proxyPort },
      reply: { procRunning: { port: network.proxyPort, pid: 1, version: expectedHostVersion, proxyAuth: proxyCredentials } },
    });
    await nativeUpdate(popup, { reply: { status: recovered } });
    await waitForRouting(popup, "active");
    await navigate(browser, network, "/recovered-through-proxy", { proxied: true });

    await popup.evaluate(() => window.routingTestPort.postMessage({ type: "new-profile" }));
    await waitForRouting(popup, "blocked");
    const loginURL = network.baseURL + "/login";
    const needsLogin = {
      ...running, backendState: "NeedsLogin", running: false, needsLogin: true,
      selfNode: null, exitNode: null, browseToURL: loginURL,
      prefs: { ...running.prefs, controlURL: network.baseURL },
    };
    await nativeUpdate(popup, { control: { status: needsLogin }, reply: { status: needsLogin } });
    await waitForRouting(popup, "blocked");
    await navigate(browser, network, "/before-explicit-login", { blocked: true });
    await popup.waitForFunction(() => [...document.querySelectorAll("button")]
      .some((button) => button.textContent === "Disconnect and log in"));
    const loginTarget = browser.waitForTarget((target) => target.url() === loginURL, { timeout: 10_000 });
    await popup.evaluate(() => [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Disconnect and log in").click());
    const loginPage = await (await loginTarget).page();
    await loginPage.waitForFunction(() => document.body?.textContent.includes("routing origin reached"));
    await loginPage.close();
    await waitForRouting(popup, "direct");
    const loginHits = network.hits.filter((hit) => hit.path === "/login");
    assert.ok(loginHits.length > 0 && loginHits.every((hit) => !hit.proxied), "Login did not use normal routing");

    const newAccount = {
      ...running, selfNode: { ...running.selfNode, id: "new-account" },
      prefs: { ...running.prefs, controlURL: network.baseURL },
    };
    await nativeUpdate(popup, { control: { status: newAccount }, reply: { status: newAccount } });
    await waitForRouting(popup, "active");
    assert.equal(await popup.evaluate(() => window.routingTestState.selectedExitNodeID), null);
    await navigate(browser, network, "/new-account-direct");
    await popup.evaluate(() => window.routingTestPort.postMessage({ type: "switch-profile", profileID: "original-account" }));
    await nativeUpdate(popup, { control: { status: recovered }, reply: { status: recovered } });
    await waitForRouting(popup, "active");
    assert.equal(await popup.evaluate(() => window.routingTestState.selectedExitNodeID), exit.id);
    await navigate(browser, network, "/original-account-restored", { proxied: true });

    await nativeUpdate(popup, { control: { nativeFailure: "unavailable" }, disconnect: true });
    await waitForRouting(popup, "blocked");
    await navigate(browser, network, "/helper-disconnected", { blocked: true });

    await popup.evaluate((host) => window.routingTestPort.postMessage({
      type: "set-domain-split", config: { mode: "bypass", domains: [host] },
    }), routingTestHost);
    await waitForRouting(popup, "blocked", routingTestHost);
    await navigate(browser, network, "/requested-bypass");

    assert.equal(network.hits.filter((hit) => ["/missing-exit", "/offline-exit", "/before-explicit-login", "/helper-disconnected"].includes(hit.path)).length, 0);
  } finally {
    await popup?.close();
    await network.close();
  }
}
