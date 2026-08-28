import {
  clickText,
  expandDisclosureRow,
  expectText,
  expectTextIn,
  pacHasExactHostRule,
  setInputValue,
  waitForPopup,
} from "../assertions.mjs";
import { makeControl, makeRunningState } from "../fixtures.mjs";

export const suite = "full";
export const browsers = ["chrome"];

export const control = () =>
  makeControl({
    status: makeRunningState({
      exitNode: {
        id: "peer-exit",
        hostname: "exitbox",
        dnsName: "exitbox.example.ts.net.",
        location: {
          city: "New York",
          cityCode: "nyc",
          country: "United States",
          countryCode: "US",
        },
        online: true,
      },
    }),
  });

async function getPacScript(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        chrome.proxy.settings.get({ incognito: false }, (details) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(details.value?.pacScript?.data ?? "");
        });
      }),
  );
}

async function waitForPacDomain(page, expectedHost) {
  const start = Date.now();
  while (Date.now() - start < 5_000) {
    const data = await getPacScript(page);
    if (pacHasExactHostRule(data, expectedHost)) return data;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `PAC script never contained exact host rule: ${expectedHost}`,
  );
}

async function waitForPacWithoutDomain(page, unexpectedHost) {
  const start = Date.now();
  while (Date.now() - start < 5_000) {
    const data = await getPacScript(page);
    if (!pacHasExactHostRule(data, unexpectedHost)) return data;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `PAC script still contained exact host rule: ${unexpectedHost}`,
  );
}

export async function run({ openPopup }) {
  const page = await openPopup();
  try {
    await waitForPopup(page);
    await expectText(page, "example.ts.net");
    await expectTextIn(page, ".split-tunneling-header", "Off");

    await expandDisclosureRow(page, ".split-tunneling-header");
    await setInputValue(
      page,
      ".split-tunneling-input",
      "teams.microsoft.com\noutlook.office.com",
    );
    await clickText(page, "Save rules", "button");

    const pac = await waitForPacDomain(page, "teams.microsoft.com");
    if (!pacHasExactHostRule(pac, "outlook.office.com")) {
      throw new Error("PAC missing outlook.office.com");
    }
    if (!pac.includes('return "DIRECT"')) {
      throw new Error("Bypass branch missing from PAC");
    }
    if (!pac.includes("SOCKS5 127.0.0.1:1055")) {
      throw new Error("Proxy still expected for unlisted hosts");
    }

    await expectTextIn(page, ".split-tunneling-header", "Bypass · 2 domains");

    // Regression (#116): a freshly opened popup starts with the editor
    // collapsed, so the row itself has to report the saved rules. It used to
    // render an off-looking switch, which read as "split tunneling disabled"
    // while the rules were in force.
    const reopened = await openPopup();
    try {
      await waitForPopup(reopened);
      await expectTextIn(
        reopened,
        ".split-tunneling-header",
        "Bypass · 2 domains",
      );
    } finally {
      await reopened.close();
    }

    // Regression: typing new domains and clicking a mode button (without
    // clicking Save) must commit both the new mode AND the typed domains,
    // not the previously-saved domain list.
    await page.$eval(
      ".split-tunneling-input",
      (el, value) => {
        el.value = value;
      },
      "work.example.com",
    );
    await page.click('.split-tunneling-mode-btn[data-mode="only"]');
    await waitForPacWithoutDomain(page, "teams.microsoft.com");
    const pacAfterMode = await getPacScript(page);
    if (!pacHasExactHostRule(pacAfterMode, "work.example.com")) {
      throw new Error(
        "Mode click dropped the unsaved textarea entry (regression)",
      );
    }
    if (pacHasExactHostRule(pacAfterMode, "outlook.office.com")) {
      throw new Error(
        "Mode click kept stale saved domains instead of textarea contents",
      );
    }

    // Regression: Only mode with an empty list must route the catch-all
    // DIRECT, not silently fall through to "everything via exit node".
    await page.$eval(
      ".split-tunneling-input",
      (el) => {
        el.value = "";
      },
    );
    await clickText(page, "Save rules", "button");
    await waitForPacWithoutDomain(page, "work.example.com");
    const pacEmptyOnly = await getPacScript(page);
    const catchAllSection = pacEmptyOnly
      .split("// No subnet routes")
      .at(-1) ?? "";
    if (!catchAllSection.includes('return "DIRECT"')) {
      throw new Error(
        "Only mode with empty list should route catch-all DIRECT",
      );
    }
    if (/return proxy;\s*\n\s*}$/.test(pacEmptyOnly)) {
      throw new Error(
        "Only mode with empty list should not fall through to proxy",
      );
    }
  } finally {
    await page.close();
  }
}
