/**
 * Smoke test: the popup HTML loads, the bundle executes, and the loading
 * spinner is replaced with a real view (any of: needs-install, needs-login,
 * disconnected, connected). The native host is unavailable in CI, so this
 * normally lands on the "needs-install" view.
 */
export async function run({ openPopup }) {
  const consoleErrors = [];
  const page = await openPopup({
    beforeNavigate(popupPage) {
      popupPage.on("pageerror", (err) => consoleErrors.push(err.message));
      popupPage.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
    },
  });

  try {
    await page.waitForFunction(
      () => {
        const root = document.querySelector("#root");
        return (
          root && !root.querySelector(".spinner") && root.children.length > 0
        );
      },
      { timeout: 10_000 },
    );

    const { hasView, hasContent } = await page.evaluate(() => {
      const root = document.querySelector("#root");
      return {
        hasView: !!root?.querySelector(".view"),
        hasContent: (root?.textContent ?? "").trim().length > 0,
      };
    });

    if (!hasContent) {
      throw new Error("popup-loads: #root has no rendered content");
    }
    if (!hasView) {
      throw new Error("popup-loads: expected a .view container in #root");
    }
    if (consoleErrors.length > 0) {
      throw new Error(
        `popup-loads: console errors during render:\n  - ${consoleErrors.join("\n  - ")}`,
      );
    }
  } finally {
    await page.close();
  }
}

export const name = "popup-loads";
