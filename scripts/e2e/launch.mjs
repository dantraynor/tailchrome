import puppeteer from "puppeteer";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { chromeExtensionId, firefoxAddonId } = JSON.parse(
  readFileSync(resolve(repoRoot, "config/extension-ids.json"), "utf8"),
);

const firefoxExtensionUuid = "6f0f1dbf-8f16-4c9b-a902-3e47e22d5d27";
// Firefox 153 blocks WebDriver BiDi from navigating a regular tab to a
// moz-extension URL (https://bugzilla.mozilla.org/show_bug.cgi?id=1959376).
// Keep the suite reproducible on the latest compatible release until Firefox
// exposes extension pages to BiDi.
const defaultFirefoxBuildId = "stable_152.0";

function shCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }

  return result.stdout.trim();
}

async function hasChromeInstalled() {
  try {
    return existsSync(await puppeteer.executablePath());
  } catch {
    return false;
  }
}

async function ensureChromeInstalled() {
  if (await hasChromeInstalled()) return;

  console.log("> pnpm exec puppeteer browsers install chrome");
  const result = spawnSync(
    "pnpm",
    ["exec", "puppeteer", "browsers", "install", "chrome"],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    throw new Error("Failed to install Puppeteer's Chrome browser");
  }
}

async function chromeExecutablePath() {
  if (process.env.CHROME_BINARY) return process.env.CHROME_BINARY;
  return puppeteer.executablePath();
}

function ensureFirefoxInstalled() {
  const firefoxBinary = process.env.FIREFOX_BINARY;
  if (firefoxBinary) {
    if (!existsSync(firefoxBinary)) {
      throw new Error(`FIREFOX_BINARY does not exist: ${firefoxBinary}`);
    }
    return firefoxBinary;
  }

  const firefoxBuildId =
    process.env.FIREFOX_BUILD_ID ?? defaultFirefoxBuildId;
  return shCapture("pnpm", [
    "exec",
    "puppeteer",
    "browsers",
    "install",
    `firefox@${firefoxBuildId}`,
    "--format",
    "{{path}}",
  ])
    .split(/\r?\n/)
    .at(-1);
}

function isNavigationTimeout(err) {
  return (
    err?.name === "TimeoutError" ||
    (typeof err?.message === "string" &&
      err.message.includes("Navigation timeout"))
  );
}

async function launchChrome(extensionDir) {
  await ensureChromeInstalled();

  const headless = process.env.HEADLESS !== "false";
  const userDataDir = mkdtempSync(resolve(tmpdir(), "tailchrome-chrome-profile-"));
  const browser = await puppeteer.launch({
    headless,
    executablePath: await chromeExecutablePath(),
    userDataDir,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  return {
    browser,
    extensionId: chromeExtensionId,
    async openPopup({ beforeNavigate } = {}) {
      const page = await browser.newPage();
      beforeNavigate?.(page);
      const url = `chrome-extension://${chromeExtensionId}/popup.html`;
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return page;
    },
  };
}

async function launchFirefox(extensionDir) {
  const executablePath = ensureFirefoxInstalled();
  const headless = process.env.HEADLESS !== "false";
  const userDataDir = mkdtempSync(resolve(tmpdir(), "tailchrome-firefox-profile-"));
  const browser = await puppeteer.launch({
    browser: "firefox",
    executablePath,
    headless,
    userDataDir,
    extraPrefsFirefox: {
      "extensions.webextensions.uuids": JSON.stringify({
        [firefoxAddonId]: firefoxExtensionUuid,
      }),
    },
  });

  await browser.installExtension(extensionDir);

  return {
    browser,
    extensionId: firefoxAddonId,
    async openPopup({ beforeNavigate } = {}) {
      const page = await browser.newPage();
      beforeNavigate?.(page);
      const url = `moz-extension://${firefoxExtensionUuid}/popup.html`;
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 5_000 });
      } catch (err) {
        // Firefox's BiDi navigation can keep waiting after extension content is
        // available. The scenario assertions below verify the page actually ran.
        if (!isNavigationTimeout(err)) throw err;
      }
      return page;
    },
  };
}

export async function launch(extensionDir, { browserName = "chrome" } = {}) {
  if (browserName === "chrome") {
    return launchChrome(extensionDir);
  }
  if (browserName === "firefox") {
    return launchFirefox(extensionDir);
  }

  throw new Error(`Unsupported e2e browser: ${browserName}`);
}
