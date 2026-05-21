import {
  clickText,
  clickToggleForLabel,
  expectText,
  waitForPopup,
  waitForRequest,
} from "../assertions.mjs";
import { makeControl, makeNeedsLoginState } from "../fixtures.mjs";

export const suite = "full";
export const browsers = ["chrome"];

export const cases = [
  {
    name: "login opens allowed login URL",
    control: () => makeControl({ status: makeNeedsLoginState() }),
    run: async ({ browser, openPopup }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        const targetPromise = browser.waitForTarget((target) =>
          target.url().startsWith("https://login.tailscale.com/a/test"),
        );
        await page.click(".btn-primary");
        await targetPromise;
      } finally {
        await page.close();
      }
    },
  },
  {
    name: "invalid login URL is ignored",
    control: () =>
      makeControl({
        status: makeNeedsLoginState({
          browseToURL: "https://example.com/phishing",
        }),
      }),
    run: async ({ browser, openPopup }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        await clickText(page, "Log In", "button");
        await new Promise((resolve) => setTimeout(resolve, 500));
        const opened = browser
          .targets()
          .some((target) => target.url().startsWith("https://example.com/phishing"));
        if (opened) throw new Error("Invalid login URL was opened");
      } finally {
        await page.close();
      }
    },
  },
  {
    name: "login requests fresh URL when current state has none",
    control: () =>
      makeControl({
        status: makeNeedsLoginState({ browseToURL: "" }),
        loginStatus: makeNeedsLoginState({
          browseToURL: "https://login.tailscale.com/a/refreshed",
        }),
      }),
    run: async ({ browser, openPopup, nativeHost }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        const targetPromise = browser.waitForTarget((target) =>
          target.url().startsWith("https://login.tailscale.com/a/refreshed"),
        );
        await clickText(page, "Log In", "button");
        await waitForRequest(nativeHost, "login");
        await targetPromise;
      } finally {
        await page.close();
      }
    },
  },
  {
    name: "footer links and local node links open tabs",
    control: () => makeControl(),
    run: async ({ browser, openPopup }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        await expectText(page, "example.ts.net");
        let targetPromise = browser.waitForTarget((target) =>
          target.url().startsWith("https://login.tailscale.com/admin"),
        );
        await clickText(page, "Admin Console", "a");
        await targetPromise;

        targetPromise = browser.waitForTarget((target) =>
          target.url().startsWith("https://github.com/dantraynor/tailchrome"),
        );
        await clickText(page, "Star the repo!", "a");
        await targetPromise;

        await clickToggleForLabel(page, "Advanced");
        await expectText(page, "Local node page");
        targetPromise = browser.waitForTarget((target) =>
          target.url().startsWith("http://100.100.100.100"),
        );
        await clickText(page, "Local node page");
        await targetPromise;
      } finally {
        await page.close();
      }
    },
  },
];
