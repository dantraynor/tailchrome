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
    await expectText(page, "Exit Nodes");
    await expectText(page, "Recommended");
    await expectText(page, "None (direct connection)");
    await expectText(page, "My Devices");
    await expectText(page, "Mullvad VPN");

    // Tokyo only appears on peer-exit-tokyo, so the click can't be intercepted
    // by the Recommended row (Mullvad NYC) or the New York My Devices row.
    await clickText(page, "Tokyo", ".exit-node-row");
    await waitForRequest(nativeHost, "set-exit-node", (msg) => msg.nodeID === "peer-exit-tokyo");

    await page.click("#allow-lan");
    await waitForRequest(nativeHost, "set-prefs", (msg) => msg.prefs.exitNodeAllowLANAccess === true);

    await setInputValue(page, ".peer-search", "mullvad");
    await expectText(page, "Mullvad VPN");
    await expectNoText(page, "Recommended");
  } finally {
    await page.close();
  }
}
