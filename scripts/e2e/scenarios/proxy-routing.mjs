import {
  clickHeaderToggle,
  expectText,
  getProxyConfig,
  waitForPopup,
  waitForRequest,
} from "../assertions.mjs";
import { makeControl, makeRunningState, makeStoppedState } from "../fixtures.mjs";

export const suite = "smoke";
export const browsers = ["chrome"];

export const control = () => makeControl({
  status: makeStoppedState(),
  commandReplies: { up: { status: makeRunningState() } },
});

export async function run({ openPopup, nativeHost, control }) {
  const page = await openPopup();
  try {
    await waitForPopup(page);
    // A fresh profile defaults to disconnected. Explicitly connect before
    // asserting routing, then wait for Chrome's asynchronous settings apply.
    await clickHeaderToggle(page);
    await waitForRequest(nativeHost, "up");
    await expectText(page, "example.ts.net");
    await page.waitForFunction(
      (port) => new Promise((resolve, reject) => {
        chrome.proxy.settings.get({ incognito: false }, (details) => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(
            details.value.mode === "pac_script" &&
            details.value.pacScript?.data.includes(`PROXY 127.0.0.1:${port}`) &&
            !details.value.pacScript?.data.includes("tailchrome-proxy-auth.invalid"),
          );
        });
      }),
      { timeout: 5_000 },
      control.proxyPort,
    );
    const proxyConfig = await getProxyConfig(page);

    if (proxyConfig.mode !== "pac_script") {
      throw new Error(`Expected pac_script proxy mode, got ${proxyConfig.mode}`);
    }
    const data = proxyConfig.pacScript?.data ?? "";
    for (const expected of [
      `PROXY 127.0.0.1:${control.proxyPort}`,
      "100.100.100.100",
      "100.64.0.0",
      "fd7a:115c:a1e0:",
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
