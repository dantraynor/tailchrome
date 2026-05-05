#!/usr/bin/env node
/**
 * Build the extension on the current branch (or a PR branch) and run
 * Puppeteer scenarios against it.
 *
 *   pnpm e2e
 *   pnpm e2e --suite=full
 *   pnpm e2e:firefox
 *   pnpm e2e 123
 *   HEADLESS=false pnpm e2e
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./launch.mjs";
import { createNativeHost } from "./native-host.mjs";
import { makeControl } from "./fixtures.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scenariosDir = resolve(dirname(fileURLToPath(import.meta.url)), "scenarios");
const supportedBrowsers = new Set(["chrome", "firefox"]);
const supportedSuites = new Set(["smoke", "full"]);

function sh(cmd) {
  const result = spawnSync(cmd, {
    shell: true,
    stdio: "inherit",
    cwd: repoRoot,
  });
  if (result.status !== 0) throw new Error(`Command failed: ${cmd}`);
}

function shCapture(cmd) {
  return execSync(cmd, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function requireCleanTree() {
  const status = shCapture("git status --porcelain");
  if (status) {
    console.error(
      "Working tree is dirty. Commit or stash changes before running e2e:\n" +
        status,
    );
    process.exit(2);
  }
}

function parseArgs(argv) {
  let browserName = process.env.BROWSER ?? "chrome";
  let suite = process.env.SUITE ?? "smoke";
  let grep = process.env.GREP ?? "";
  let pr;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      continue;
    } else if (arg === "--chrome") {
      browserName = "chrome";
    } else if (arg === "--firefox") {
      browserName = "firefox";
    } else if (arg === "--browser") {
      browserName = argv[++index];
    } else if (arg.startsWith("--browser=")) {
      browserName = arg.slice("--browser=".length);
    } else if (arg === "--suite") {
      suite = argv[++index];
    } else if (arg.startsWith("--suite=")) {
      suite = arg.slice("--suite=".length);
    } else if (arg === "--grep") {
      grep = argv[++index];
    } else if (arg.startsWith("--grep=")) {
      grep = arg.slice("--grep=".length);
    } else if (!pr) {
      pr = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!supportedBrowsers.has(browserName)) {
    throw new Error(`Unsupported e2e browser: ${browserName}`);
  }
  if (!supportedSuites.has(suite)) {
    throw new Error(`Unsupported e2e suite: ${suite}`);
  }

  return { browserName, suite, grep, pr };
}

async function loadCases({ browserName, suite, grep }) {
  const files = readdirSync(scenariosDir)
    .filter((f) => f.endsWith(".mjs"))
    .sort();

  const cases = [];
  for (const file of files) {
    const mod = await import(resolve(scenariosDir, file));
    const browsers = mod.browsers ?? ["chrome", "firefox"];
    const scenarioSuite = mod.suite ?? "full";
    if (!browsers.includes(browserName)) continue;
    if (suite === "smoke" && scenarioSuite !== "smoke") continue;

    const scenarioCases = mod.cases ?? [
      {
        name: mod.name ?? file.replace(/\.mjs$/, ""),
        control: mod.control,
        nativeHost: mod.nativeHost,
        run: mod.run,
      },
    ];

    for (const testCase of scenarioCases) {
      const name = `${file.replace(/\.mjs$/, "")}: ${testCase.name}`;
      if (grep && !name.includes(grep)) continue;
      cases.push({ file, name, mod, testCase });
    }
  }
  return cases;
}

async function runCase({ browserName, extensionDir, item }) {
  const { testCase, name } = item;
  const control =
    typeof testCase.control === "function"
      ? testCase.control()
      : (testCase.control ?? makeControl());
  const nativeHost = createNativeHost(browserName, control, {
    enabled: testCase.nativeHost !== false,
  });
  let browser;

  let failed = false;
  try {
    const caseExtensionDir = await nativeHost.prepareExtension(extensionDir);
    const launched = await launch(caseExtensionDir, { browserName });
    browser = launched.browser;
    await testCase.run({
      browser,
      browserName,
      openPopup: launched.openPopup,
      nativeHost,
      control,
    });
  } catch (err) {
    failed = true;
    const requests = nativeHost.readRequests();
    if (requests.length === 0) {
      console.error(`    Native host saw no requests. Artifacts: ${nativeHost.root}`);
    } else {
      console.error(
        `    Native host requests:\n${requests
          .map((entry) => `      ${JSON.stringify(entry.msg)}`)
          .join("\n")}`,
      );
    }
    throw err;
  } finally {
    if (browser) await browser.close();
    if (process.env.KEEP_E2E_ARTIFACTS === "true" && failed) {
      console.error(`    Keeping e2e artifacts: ${nativeHost.root}`);
    } else {
      nativeHost.cleanup();
    }
  }

  process.stdout.write(`  • ${name} … ok\n`);
}

async function main() {
  const { browserName, suite, grep, pr } = parseArgs(process.argv.slice(2));

  let restore = () => {};
  let exitCode = 0;

  try {
    if (pr) {
      requireCleanTree();
      const ref = shCapture("git rev-parse --abbrev-ref HEAD");
      const original = ref === "HEAD" ? shCapture("git rev-parse HEAD") : ref;
      restore = () => {
        const current = shCapture("git rev-parse --abbrev-ref HEAD");
        if (current === original) return;
        console.log(`> Restoring branch: ${original}`);
        try {
          sh(`git checkout ${original}`);
        } catch (err) {
          console.error(`Failed to restore branch ${original}:`, err.message);
        }
      };
      console.log(`> gh pr checkout ${pr}`);
      sh(`gh pr checkout ${pr}`);
    } else {
      const ref = shCapture("git rev-parse --abbrev-ref HEAD");
      console.log(`> Testing current branch: ${ref}`);
    }

    console.log(`> pnpm build:${browserName}`);
    sh(`pnpm build:${browserName}`);

    const extensionDir = resolve(
      repoRoot,
      `packages/extension/.output/${browserName}-mv3`,
    );
    if (!existsSync(extensionDir)) {
      throw new Error(`Built extension not found at ${extensionDir}`);
    }

    const cases = await loadCases({ browserName, suite, grep });
    if (cases.length === 0) {
      throw new Error(`No ${suite} e2e cases found for ${browserName}`);
    }

    console.log(`> Running ${cases.length} ${suite} case(s) in ${browserName}`);
    let failures = 0;
    for (const item of cases) {
      try {
        await runCase({ browserName, extensionDir, item });
      } catch (err) {
        failures += 1;
        console.log(`  • ${item.name} … FAIL`);
        console.error(`    ${err.stack ?? err.message}`);
      }
    }

    if (failures > 0) {
      exitCode = 1;
      console.error(`\n${failures} case(s) failed.`);
    } else {
      console.log(`\nAll ${cases.length} case(s) passed.`);
    }
  } catch (err) {
    exitCode = 1;
    console.error(err.message);
  } finally {
    restore();
  }

  process.exit(exitCode);
}

main();
