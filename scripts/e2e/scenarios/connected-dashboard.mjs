import { expectText, setInputValue, waitForPopup } from "../assertions.mjs";
import { makeControl, makeRunningState } from "../fixtures.mjs";

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
    await expectText(page, "Native helper 0.1.9");
    await expectText(page, "Network lock is enabled");
    await expectText(page, "router");
    await expectText(page, "laptop");
    await expectText(page, "archive");

    await setInputValue(page, ".peer-search", "laptop");
    await expectText(page, "laptop");
    await page.waitForFunction(() => !document.body.innerText.includes("router"));
  } finally {
    await page.close();
  }
}
