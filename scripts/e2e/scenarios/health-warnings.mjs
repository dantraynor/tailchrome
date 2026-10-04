import assert from "node:assert/strict";
import { expectNoText, expectText, waitForPopup } from "../assertions.mjs";
import { makeControl, makeRunningState } from "../fixtures.mjs";

export const suite = "full";
export const browsers = ["chrome", "firefox"];

const experimentalNotice =
  "This is an unstable version of Tailscale meant for testing and development purposes. Please report any issues to Tailscale.";

async function expectNoHealthWarnings(page) {
  await page.waitForSelector(".health-warnings", { hidden: true });
  await expectNoText(page, experimentalNotice);
}

async function sendHealthUpdate(page, health) {
  await page.evaluate(
    (status) => chrome.runtime.sendMessage({ tailchromeE2ENative: { reply: { status } } }),
    makeRunningState({ health }),
  );
}

export const cases = [
  {
    name: "older helper experimental notice does not create a warning banner",
    control: () => makeControl({
      hostVersion: "0.1.14",
      status: makeRunningState({ health: [experimentalNotice] }),
    }),
    run: async ({ openPopup }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        await expectText(page, "example.ts.net");
        await expectText(page, "Native helper 0.1.14");
        await expectNoHealthWarnings(page);
      } finally {
        await page.close();
      }
    },
  },
  {
    name: "genuine warnings remain visible and clear after recovery",
    control: () => makeControl({
      allowRuntimeUpdates: true,
      status: makeRunningState({
        health: ["Network lock is enabled", experimentalNotice, "DERP latency is high"],
      }),
    }),
    run: async ({ openPopup }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        await expectText(page, "example.ts.net");
        await expectText(page, "2 warnings");
        await expectText(page, "Network lock is enabled");
        await expectText(page, "DERP latency is high");
        await expectNoText(page, experimentalNotice);
        assert.deepEqual(
          await page.$$eval(".health-warnings-item", (items) => items.map((item) => item.textContent)),
          ["Network lock is enabled", "DERP latency is high"],
        );

        // A remaining build notice must not leave the previous banner behind.
        await sendHealthUpdate(page, [experimentalNotice]);
        await expectNoHealthWarnings(page);
        await expectNoText(page, "Network lock is enabled");
        await expectNoText(page, "DERP latency is high");

        // Further health updates still render and recover normally.
        await sendHealthUpdate(page, ["DNS configuration needs attention"]);
        await expectText(page, "1 warning");
        await expectText(page, "DNS configuration needs attention");
        await sendHealthUpdate(page, []);
        await expectNoHealthWarnings(page);
        await expectNoText(page, "DNS configuration needs attention");
      } finally {
        await page.close();
      }
    },
  },
];
