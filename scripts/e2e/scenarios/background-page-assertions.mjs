import assert from "node:assert/strict";
import { expectText, expectTextIn, waitForPopup } from "../assertions.mjs";

export const suite = "smoke";
export const browsers = ["chrome"];

const expected = "Background update completed";

export const cases = [
  { name: "popup readiness", wait: waitForPopup },
  { name: "page text", wait: (page) => expectText(page, expected) },
  { name: "element text", wait: (page) => expectTextIn(page, ".result", expected) },
].map(({ name, wait }) => ({
  name: `${name} updates while another tab is active`,
  nativeHost: false,
  run: async ({ browser }) => {
    const page = await browser.newPage();
    let foreground;
    try {
      await page.setContent('<main id="root"><div class="skeleton"></div><p class="result">Loading</p></main>');
      foreground = await browser.newPage();
      await foreground.bringToFront();
      assert.equal(await page.evaluate(() => document.hidden), true);

      // Let the wait observe the initial loading state before updating the
      // background document; its animation frames are paused by Chrome.
      const update = new Promise((resolve) => setTimeout(resolve, 250)).then(() =>
        page.evaluate((text) => {
          document.querySelector(".skeleton").remove();
          document.querySelector(".result").textContent = text;
        }, expected),
      );
      await Promise.all([wait(page), update]);
    } finally {
      await foreground?.close();
      await page.close();
    }
  },
}));
