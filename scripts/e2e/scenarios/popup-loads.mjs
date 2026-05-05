import { expectText, waitForPopup } from "../assertions.mjs";
import { makeControl } from "../fixtures.mjs";

export const name = "popup-loads";
export const suite = "smoke";
export const browsers = ["chrome", "firefox"];

export const control = () => makeControl();

export async function run({ openPopup }) {
  const consoleErrors = [];
  const page = await openPopup({
    beforeNavigate(popupPage) {
      popupPage.on("pageerror", (err) => consoleErrors.push(err.message));
      popupPage.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
    },
  });

  try {
    await waitForPopup(page);
    await expectText(page, "example.ts.net");
    await expectText(page, "router");

    const hasView = await page.$(".view");
    if (!hasView) {
      throw new Error("popup-loads: expected a .view container in #root");
    }
    if (consoleErrors.length > 0) {
      throw new Error(
        `popup-loads: console errors during render:\n  - ${consoleErrors.join("\n  - ")}`,
      );
    }
  } finally {
    await page.close();
  }
}
