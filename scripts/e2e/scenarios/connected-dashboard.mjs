import { clickText, expectText, setInputValue, waitForPopup } from "../assertions.mjs";
import {
  expectedHostVersion,
  makeControl,
  makeRunningState,
} from "../fixtures.mjs";

export const suite = "full";
export const browsers = ["chrome", "firefox"];

export const control = () =>
  makeControl({
    status: makeRunningState({
      health: ["Network lock is enabled", "DERP latency is high"],
    }),
  });

export async function run({ openPopup }) {
  const page = await openPopup();
  try {
    await waitForPopup(page);
    await expectText(page, "example.ts.net");
    await expectText(page, "100.64.0.1");
    await expectText(page, "browser-node");
    await expectText(page, `Native helper ${expectedHostVersion}`);
    await expectText(page, "Network lock is enabled");
    await expectText(page, "router");
    await expectText(page, "laptop");
    await page.waitForFunction(() => document.querySelectorAll(".peer-item").length === 5);
    await clickText(page, "View all", ".peer-list-toggle");
    await expectText(page, "archive");
    await clickText(page, "Profile", ".setting-row-profile");
    await expectText(page, "Profiles");
    await clickText(page, "Back", "button");
    await expectText(page, "archive");
    await clickText(page, "Show fewer", ".peer-list-toggle");
    await page.waitForFunction(() => document.querySelectorAll(".peer-item").length === 5);

    await setInputValue(page, ".peer-search", "archive");
    await expectText(page, "archive");
    await page.waitForFunction(() => document.querySelectorAll(".peer-item").length === 1);

    await setInputValue(page, ".peer-search", "laptop");
    await expectText(page, "laptop");
    await page.waitForFunction(() => !document.body.innerText.includes("router"));
  } finally {
    await page.close();
  }
}
