import { readFileSync } from "node:fs";

export async function waitForPopup(page) {
  await page.waitForFunction(
    () => {
      const root = document.querySelector("#root");
      if (!root) return false;
      if (root.querySelector(".spinner")) return false;
      if (root.querySelector(".skeleton")) return false;
      return root.children.length > 0;
    },
    { timeout: 10_000 },
  );
}

export async function visibleText(page) {
  return page.evaluate(() => document.body.innerText);
}

export async function expectText(page, expected) {
  try {
    await page.waitForFunction(
      (text) => document.body.innerText.includes(text),
      { timeout: 5_000 },
      expected,
    );
  } catch (err) {
    const text = await visibleText(page).catch(() => "");
    throw new Error(
      `Expected text not found: ${expected}\nVisible text:\n${text}`,
      { cause: err },
    );
  }
}

export async function expectNoText(page, unexpected) {
  const text = await visibleText(page);
  if (text.includes(unexpected)) {
    throw new Error(`Unexpected text found: ${unexpected}`);
  }
}

export async function clickText(page, text, selector = "button, a, [role='button'], [role='radio'], .setting-row--clickable, .setting-row, .peer-item") {
  const clicked = await page.evaluate(
    ({ text, selector }) => {
      const candidates = [...document.querySelectorAll(selector)];
      const el = candidates.find((candidate) =>
        (candidate.textContent ?? "").includes(text),
      );
      if (!el) return false;
      el.click();
      return true;
    },
    { text, selector },
  );
  if (!clicked) throw new Error(`Could not click text: ${text}`);
}

export async function clickHeaderToggle(page) {
  const clicked = await page.evaluate(() => {
    const input = document.querySelector(".header .toggle-switch input");
    if (!input) return false;
    input.click();
    return true;
  });
  if (!clicked) throw new Error("Could not click header toggle");
}

export async function setInputValue(page, selector, value) {
  await page.waitForSelector(selector);
  await page.focus(selector);
  await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
  await page.keyboard.press("A");
  await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
  await page.keyboard.type(value);
}

export async function clickToggleForLabel(page, label) {
  const clicked = await page.evaluate((label) => {
    const rows = [...document.querySelectorAll(".setting-row, .header")];
    const row = rows.find((candidate) =>
      (candidate.textContent ?? "").includes(label),
    );
    const input = row?.querySelector("input[type='checkbox']");
    if (!input) return false;
    input.click();
    return true;
  }, label);
  if (!clicked) {
    const text = await visibleText(page).catch(() => "");
    throw new Error(`Could not click toggle for label: ${label}\nVisible text:\n${text}`);
  }
}

export async function waitForRequest(nativeHost, cmd, predicate = () => true) {
  const start = Date.now();
  while (Date.now() - start < 5_000) {
    const request = nativeHost
      .readRequests()
      .find((entry) => entry.msg.cmd === cmd && predicate(entry.msg));
    if (request) return request.msg;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for native request: ${cmd}`);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
