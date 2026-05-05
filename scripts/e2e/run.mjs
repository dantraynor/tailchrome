#!/usr/bin/env node
/**
 * Build the extension on the current branch (or a PR branch) and run
 * Puppeteer scenarios against it.
 *
 *   pnpm e2e              # test the current branch
 *   pnpm e2e:firefox      # test the Firefox build
 *   pnpm e2e 123          # gh pr checkout 123, test, then restore the branch
 *   pnpm e2e --browser=firefox 123
 *   HEADLESS=false pnpm e2e
 *
 * Aborts on a dirty working tree. Restores the original branch on exit.
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./launch.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scenariosDir = resolve(dirname(fileURLToPath(import.meta.url)), "scenarios");
const supportedBrowsers = new Set(["chrome", "firefox"]);

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
  let pr;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--chrome") {
      browserName = "chrome";
    } else if (arg === "--firefox") {
      browserName = "firefox";
    } else if (arg === "--browser") {
      browserName = argv[++index];
    } else if (arg.startsWith("--browser=")) {
      browserName = arg.slice("--browser=".length);
    } else if (!pr) {
      pr = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!supportedBrowsers.has(browserName)) {
    throw new Error(`Unsupported e2e browser: ${browserName}`);
  }

  return { browserName, pr };
}

async function main() {
  const { browserName, pr } = parseArgs(process.argv.slice(2));

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

    const { browser, openPopup } = await launch(extensionDir, { browserName });
    try {
      const files = readdirSync(scenariosDir)
        .filter((f) => f.endsWith(".mjs"))
        .sort();

      let failures = 0;
      for (const file of files) {
        const mod = await import(resolve(scenariosDir, file));
        const name = mod.name ?? file.replace(/\.mjs$/, "");
        process.stdout.write(`  • ${name} … `);
        try {
          await mod.run({ browser, openPopup });
          console.log("ok");
        } catch (err) {
          failures += 1;
          console.log("FAIL");
          console.error(`    ${err.stack ?? err.message}`);
        }
      }

      if (failures > 0) {
        exitCode = 1;
        console.error(`\n${failures} scenario(s) failed.`);
      } else {
        console.log(`\nAll ${files.length} scenario(s) passed.`);
      }
    } finally {
      await browser.close();
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
