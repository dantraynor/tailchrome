import puppeteer from "puppeteer";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { chromeExtensionId } = JSON.parse(
  readFileSync(resolve(repoRoot, "config/extension-ids.json"), "utf8"),
);

function hasChromeInstalled() {
  try {
    return existsSync(puppeteer.executablePath());
  } catch {
    return false;
  }
}

function ensureChromeInstalled() {
  if (hasChromeInstalled()) return;
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

export async function launch(extensionDir) {
  ensureChromeInstalled();

  const headless = process.env.HEADLESS !== "false";
  const browser = await puppeteer.launch({
    headless,
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
