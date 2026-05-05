import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

export async function run({ openPopup, nativeHost, browserName }) {
  const page = await openPopup();
  try {
    await waitForPopup(page);
    await expectText(page, "example.ts.net");
    nativeHost.clearRequests();

    await clickToggleForLabel(page, "Advanced");
    await page.evaluate(() => {
      document
        .querySelector('[data-peer-id="peer-laptop"] .peer-item')
        ?.click();
    });
    await expectText(page, "Copy IP");
    await expectText(page, "Copy DNS");
    await expectText(page, "Open");
    await expectText(page, "Ping");
    await expectText(page, "SSH");
    await expectText(page, "Send File");

    await page.evaluate(() => {
      const buttons = [
        ...document.querySelectorAll('[data-peer-id="peer-laptop"] button'),
      ];
      buttons.find((button) => button.textContent?.includes("Ping"))?.click();
    });
    await waitForRequest(nativeHost, "ping-peer", (msg) => msg.nodeID === "peer-laptop");
    await expectText(page, "pong from peer-laptop");

    await page.evaluate(() => {
      const buttons = [
        ...document.querySelectorAll('[data-peer-id="peer-laptop"] button'),
      ];
      buttons.find((button) => button.textContent?.includes("Set URL"))?.click();
    });
    await setInputValue(page, ".peer-url-input", "8443");
    await page.evaluate(() => {
      const buttons = [
        ...document.querySelectorAll('[data-peer-id="peer-laptop"] button'),
      ];
      buttons.find((button) => button.textContent?.includes("Save"))?.click();
    });
    await expectText(page, "Open :8443");

    if (browserName === "chrome") {
      const dir = mkdtempSync(join(tmpdir(), "tailchrome-file-"));
      const filePath = join(dir, "hello.txt");
      writeFileSync(filePath, "hello from tailchrome");
      const chooserPromise = page.waitForFileChooser();
      await page.evaluate(() => {
        const buttons = [
          ...document.querySelectorAll('[data-peer-id="peer-laptop"] button'),
        ];
        buttons.find((button) => button.textContent?.includes("Send File"))?.click();
      });
      const chooser = await chooserPromise;
      await chooser.accept([filePath]);
      await waitForRequest(nativeHost, "send-file", (msg) =>
        msg.nodeID === "peer-laptop" &&
        msg.fileName === "hello.txt" &&
        msg.fileData.length > 0,
      );
      await expectText(page, "sent successfully");
    }
  } finally {
    await page.close();
  }
}
