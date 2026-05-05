import { expectText, waitForPopup } from "../assertions.mjs";
import { makeControl } from "../fixtures.mjs";

export const suite = "full";
export const browsers = ["chrome"];

export const control = () => makeControl();

export async function run({ openPopup }) {
  const page = await openPopup();
  try {
    await waitForPopup(page);
    await expectText(page, "example.ts.net");
    const proxyConfig = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          chrome.proxy.settings.get({ incognito: false }, (details) => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(err.message));
            else resolve(details.value);
          });
        }),
    );

    if (proxyConfig.mode !== "pac_script") {
      throw new Error(`Expected pac_script proxy mode, got ${proxyConfig.mode}`);
    }
    const data = proxyConfig.pacScript?.data ?? "";
    for (const expected of [
      "SOCKS5 127.0.0.1:1055",
      "100.100.100.100",
      "100.64.0.0",
      ".example.ts.net",
      "192.168.50.0",
    ]) {
      if (!data.includes(expected)) {
        throw new Error(`PAC script did not include ${expected}`);
      }
    }
  } finally {
    await page.close();
  }
}
