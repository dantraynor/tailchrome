import { clickHeaderToggle, expectText, waitForPopup, waitForRequest } from "../assertions.mjs";
import { makeControl, makeNeedsLoginState, makeStoppedState } from "../fixtures.mjs";

export const suite = "full";
export const browsers = ["chrome", "firefox"];

export const cases = [
  {
    name: "connected toggle sends down",
    control: () => makeControl(),
    run: async ({ openPopup, nativeHost }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        await expectText(page, "example.ts.net");
        nativeHost.clearRequests();
        await clickHeaderToggle(page);
        await waitForRequest(nativeHost, "down");
      } finally {
        await page.close();
      }
    },
  },
  {
    name: "stopped toggle sends up",
    control: () => makeControl({ status: makeStoppedState() }),
    run: async ({ openPopup, nativeHost }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        nativeHost.clearRequests();
        await clickHeaderToggle(page);
        await waitForRequest(nativeHost, "up");
      } finally {
        await page.close();
      }
    },
  },
  {
    name: "needs login renders disabled login state",
    control: () => makeControl({ status: makeNeedsLoginState() }),
    run: async ({ openPopup }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        await expectText(page, "Log in to Tailscale");
      } finally {
        await page.close();
      }
    },
  },
];
