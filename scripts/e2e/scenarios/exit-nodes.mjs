import {
  clickText,
  expectNoText,
  expectText,
  setInputValue,
  waitForPopup,
  waitForRequest,
} from "../assertions.mjs";
import { makeControl } from "../fixtures.mjs";

export const suite = "full";
export const browsers = ["chrome", "firefox"];

export const control = () => makeControl();

export async function run({ openPopup, nativeHost }) {
  const page = await openPopup();
  try {
    await waitForPopup(page);
    await expectText(page, "example.ts.net");
    nativeHost.clearRequests();

    await clickText(page, "Exit Node");
    await waitForRequest(nativeHost, "suggest-exit-node");
    await expectText(page, "Exit Nodes");
    await expectText(page, "Recommended");
    await expectText(page, "None (direct connection)");
    await expectText(page, "My Devices");
    await expectText(page, "Mullvad VPN");

    await clickText(page, "New York", ".exit-node-row");
    await waitForRequest(nativeHost, "set-exit-node", (msg) => msg.nodeID === "peer-exit");

    await page.click("#allow-lan");
    await waitForRequest(nativeHost, "set-prefs", (msg) => msg.prefs.exitNodeAllowLANAccess === true);

    await setInputValue(page, ".peer-search", "mullvad");
    await expectText(page, "Mullvad VPN");
    await expectNoText(page, "Recommended");
  } finally {
    await page.close();
  }
}
