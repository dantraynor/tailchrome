import {
  clickText,
  clickToggleForLabel,
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

    await clickToggleForLabel(page, "Shields Up");
    await waitForRequest(nativeHost, "set-prefs", (msg) => msg.prefs.shieldsUp === true);

    await clickToggleForLabel(page, "MagicDNS");
    await waitForRequest(nativeHost, "set-prefs", (msg) => msg.prefs.corpDNS === false);

    await clickToggleForLabel(page, "Advanced");
    await clickToggleForLabel(page, "Run as Exit Node");
    await waitForRequest(nativeHost, "set-prefs", (msg) => msg.prefs.advertiseExitNode === true);

    await clickToggleForLabel(page, "Advertise subnets");
    await setInputValue(page, ".advertise-routes-input", "10.0.0.0/24\n192.168.0.0/16");
    await clickText(page, "Save routes", "button");
    await waitForRequest(nativeHost, "set-prefs", (msg) =>
      Array.isArray(msg.prefs.advertiseRoutes) &&
      msg.prefs.advertiseRoutes.includes("10.0.0.0/24") &&
      msg.prefs.advertiseRoutes.includes("192.168.0.0/16"),
    );

    await expectText(page, "Work");
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".setting-row--clickable")];
      rows.find((row) => row.textContent?.includes("Work"))?.click();
    });
    await expectText(page, "Profiles");
    await clickText(page, "Personal", ".profile-row");
    await waitForRequest(nativeHost, "switch-profile", (msg) => msg.profileID === "profile-personal");

    await page.goBack().catch(() => {});
  } finally {
    await page.close();
  }
}

export const cases = [
  {
    name: "preferences and profile commands",
    control,
    run,
  },
  {
    name: "logout command",
    control,
    run: async ({ openPopup, nativeHost }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        await expectText(page, "example.ts.net");
        nativeHost.clearRequests();

        await clickText(page, "Logout", "a");
        await waitForRequest(nativeHost, "logout");
      } finally {
        await page.close();
      }
    },
  },
];
