import { clickHeaderToggle, expectText, waitForPopup, waitForRequest } from "../assertions.mjs";
import {
  makeControl,
  makeNeedsLoginState,
  makeRunningState,
  makeStoppedState,
} from "../fixtures.mjs";

export const suite = "full";
export const browsers = ["chrome", "firefox"];

export const cases = [
  {
    name: "connected toggle sends down",
    control: () =>
      makeControl({
        status: makeStoppedState(),
        commandReplies: {
          up: { status: makeRunningState() },
          down: { status: makeStoppedState() },
        },
      }),
    run: async ({ openPopup, nativeHost }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        // A fresh e2e profile has no recorded connection intent, so the
        // startup resolution would immediately correct a Running node back
        // down. Establish the connected session through the toggle, as a
        // real session would, before exercising the disconnect path.
        await expectText(page, "Tailscale is not connected");
        await clickHeaderToggle(page);
        await waitForRequest(nativeHost, "up");
        await expectText(page, "example.ts.net");
        nativeHost.clearRequests();
        await clickHeaderToggle(page);
        await waitForRequest(nativeHost, "down");
        await expectText(page, "Tailscale is not connected");
      } finally {
        await page.close();
      }
    },
  },
  {
    name: "stopped toggle sends up",
    control: () =>
      makeControl({
        status: makeStoppedState(),
        commandReplies: { up: { status: makeRunningState() } },
      }),
    run: async ({ openPopup, nativeHost }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        nativeHost.clearRequests();
        await clickHeaderToggle(page);
        await waitForRequest(nativeHost, "up");
        await expectText(page, "example.ts.net");
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
