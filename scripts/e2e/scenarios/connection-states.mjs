import {
  clickText,
  expectNoText,
  expectText,
  waitForPopup,
} from "../assertions.mjs";
import {
  makeControl,
  makeNeedsLoginState,
  makeRunningState,
  makeStoppedState,
} from "../fixtures.mjs";

export const suite = "full";
export const browsers = ["chrome", "firefox"];

async function captureDiagnosticReport(page) {
  await page.evaluate(() => {
    globalThis.__tailchromeDiagnosticReport = null;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText(text) {
          globalThis.__tailchromeDiagnosticReport = text;
          return Promise.resolve();
        },
      },
    });
  });
  await clickText(page, "Copy diagnostic report");
  await page.waitForFunction(
    () => typeof globalThis.__tailchromeDiagnosticReport === "string",
    { timeout: 5_000 },
  );
  return page.evaluate(() => globalThis.__tailchromeDiagnosticReport);
}

export const cases = [
  {
    name: "needs install when native host is absent",
    nativeHost: false,
    run: async ({ openPopup }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        await expectText(page, "Quick Setup");
        await expectText(
          page,
          "Tailchrome could not find a registered helper for this browser.",
        );
      } finally {
        await page.close();
      }
    },
  },
  {
    name: "version difference preserves the normal running view",
    control: () => makeControl({ hostVersion: "0.0.11" }),
    run: async ({ openPopup }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        await expectText(
          page,
          "Helper 0.0.11 is older than companion release",
        );
        await expectText(page, "example.ts.net");
        await expectNoText(page, "Quick Setup");
      } finally {
        await page.close();
      }
    },
  },
  {
    name: "browser refusal renders registration repair copy",
    control: () =>
      makeControl({
        nativeFailure: "not-allowed",
        nativeFailureMessage:
          "Access to the specified native messaging host is forbidden.",
      }),
    run: async ({ openPopup }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        await expectText(
          page,
          "This browser refused access to the registered helper.",
        );
        await expectText(page, "Copy diagnostic report");
      } finally {
        await page.close();
      }
    },
  },
  {
    name: "early helper failure keeps raw detail in local diagnostics",
    control: () =>
      makeControl({
        nativeFailure: "connect-throw",
        nativeFailureMessage:
          "fixture-activation-marker /Users/alice/Library/Tailchrome https://private.example/path token=fixture-secret",
      }),
    run: async ({ openPopup }) => {
      const page = await openPopup();
      try {
        await expectText(
          page,
          "The browser found the helper, but it stopped before setup completed.",
        );
        await expectNoText(page, "fixture-activation-marker");

        const report = await captureDiagnosticReport(page);
        if (!report.includes("fixture-activation-marker")) {
          throw new Error("Diagnostic report omitted sanitized fixture detail.");
        }
        for (const excluded of [
          "/Users/alice",
          "https://private.example/path",
          "fixture-secret",
        ]) {
          if (report.includes(excluded)) {
            throw new Error(
              `Diagnostic report contained unredacted fixture data: ${excluded}`,
            );
          }
        }
      } finally {
        await page.close();
      }
    },
  },
  {
    name: "helper-reported startup error renders safe recovery",
    control: () =>
      makeControl({
        init: {
          error:
            "fixture-reported-marker /Users/alice/Library/Tailchrome access_token=fixture-reported-secret",
        },
      }),
    run: async ({ openPopup }) => {
      const page = await openPopup();
      try {
        await expectText(page, "The helper started but reported a startup error.");
        await expectText(page, "Reinstall or repair helper");
        await expectNoText(page, "fixture-reported-marker");

        const report = await captureDiagnosticReport(page);
        if (!report.includes("fixture-reported-marker")) {
          throw new Error("Diagnostic report omitted reported-error detail.");
        }
        for (const excluded of [
          "/Users/alice",
          "fixture-reported-secret",
        ]) {
          if (report.includes(excluded)) {
            throw new Error(
              `Diagnostic report contained unredacted reported-error data: ${excluded}`,
            );
          }
        }
      } finally {
        await page.close();
      }
    },
  },
  {
    name: "explicit incompatibility renders defensive installer copy",
    control: () =>
      makeControl({
        popupFailureKind: "helper-incompatible",
        popupFailureCode: "fixture-protocol-incompatible",
      }),
    run: async ({ openPopup }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        await expectText(
          page,
          "The helper and extension reported an incompatible protocol.",
        );
        await expectText(page, "Copy diagnostic report");
      } finally {
        await page.close();
      }
    },
  },
  {
    name: "late helper stop renders reconnect recovery",
    control: () =>
      makeControl({
        nativeFailure: "stopped",
        nativeFailureMessage:
          "fixture-late-stop /home/alice/.config/tailchrome",
      }),
    run: async ({ openPopup }) => {
      const page = await openPopup();
      try {
        await expectText(
          page,
          "The helper stopped after connecting. Tailchrome is retrying.",
        );
        await expectNoText(page, "fixture-late-stop");
        await expectText(page, "Retry Connection");
      } finally {
        await page.close();
      }
    },
  },
  {
    name: "manual discovery retry recovers unavailable helper",
    control: () =>
      makeControl({
        nativeFailure: "unavailable",
        nativeFailureMessage: "Specified native messaging host not found.",
        recoverOnManualRetry: true,
      }),
    run: async ({ openPopup }) => {
      const page = await openPopup();
      try {
        await waitForPopup(page);
        await expectText(
          page,
          "Tailchrome could not find a registered helper for this browser.",
        );
        await clickText(page, "Retry discovery");
        await expectText(page, "example.ts.net");
        await expectNoText(page, "Quick Setup");
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
