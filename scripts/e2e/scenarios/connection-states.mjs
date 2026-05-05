import { expectText, waitForPopup } from "../assertions.mjs";
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
    name: "needs install when native host is absent",
    nativeHost: false,
    run: async ({ openPopup }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        await expectText(page, "Quick Setup");
      } finally {
        await page.close();
      }
    },
  },
  {
    name: "needs update on host version mismatch",
    control: () => makeControl({ hostVersion: "0.2.0" }),
    run: async ({ openPopup }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        await expectText(page, "Update");
      } finally {
        await page.close();
      }
    },
  },
  {
    name: "needs login renders login action",
    control: () => makeControl({ status: makeNeedsLoginState() }),
    run: async ({ openPopup }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        await expectText(page, "Log in");
      } finally {
        await page.close();
      }
    },
  },
  {
    name: "stopped renders disconnected state",
    control: () => makeControl({ status: makeStoppedState() }),
    run: async ({ openPopup }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        await expectText(page, "Tailscale is not connected");
      } finally {
        await page.close();
      }
    },
  },
  {
    name: "machine auth warning is visible",
    control: () =>
      makeControl({
        status: makeRunningState({
          backendState: "NeedsMachineAuth",
          running: false,
          peers: [],
        }),
      }),
    run: async ({ openPopup }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        await expectText(page, "approval");
      } finally {
        await page.close();
      }
    },
  },
];
