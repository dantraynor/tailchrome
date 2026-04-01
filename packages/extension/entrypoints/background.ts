import { startChromeBackground } from "../src/background/chrome";
import { startFirefoxBackground } from "../src/background/firefox";

export default defineBackground({
  type: "module",
  main() {
    if (import.meta.env.BROWSER === "firefox") {
      startFirefoxBackground();
      return;
    }

    startChromeBackground();
  },
});
