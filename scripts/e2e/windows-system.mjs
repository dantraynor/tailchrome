#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const toolsDir = join(repoRoot, ".tools");
const nodeDir = join(toolsDir, "node");
const nodeExe = join(nodeDir, "node.exe");
const npmCli = join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
const pnpmDir = join(toolsDir, "pnpm");
const pnpmCli = join(pnpmDir, "node_modules", "pnpm", "bin", "pnpm.cjs");
const goExe = join(toolsDir, "go", "bin", "go.exe");
const dotnetExe = join(toolsDir, "dotnet", "dotnet.exe");
const wixDir = join(toolsDir, "wix");
const wixExe = join(wixDir, "wix.exe");
const distDir = join(repoRoot, "dist");
const helperExe = join(distDir, "tailscale-browser-ext-windows-amd64.exe");
const msiPath = join(distDir, "tailchrome-helper-windows-x64.msi");
const installLog = join(distDir, "msi-install.log");
const uninstallLog = join(distDir, "msi-uninstall.log");

if (process.platform !== "win32") {
  throw new Error("windows-system.mjs must run inside a Windows sandbox");
}

for (const executable of [nodeExe, npmCli, goExe, dotnetExe]) {
  if (!existsSync(executable)) {
    throw new Error(`Pinned toolchain component is missing: ${executable}`);
  }
}

const pathKey =
  Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
  "Path";
const toolEnv = {
  ...process.env,
  CI: "true",
  CGO_ENABLED: "0",
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DOTNET_NOLOGO: "1",
  DOTNET_ROOT: join(toolsDir, "dotnet"),
  GOCACHE: join(toolsDir, "go-cache"),
  GOMODCACHE: join(toolsDir, "go-mod-cache"),
  GOTOOLCHAIN: "local",
  NUGET_PACKAGES: join(toolsDir, "nuget-packages"),
  npm_config_cache: join(toolsDir, "npm-cache"),
};
toolEnv[pathKey] = [
  nodeDir,
  pnpmDir,
  join(toolsDir, "go", "bin"),
  join(toolsDir, "dotnet"),
  wixDir,
  process.env[pathKey] ?? "",
].join(";");

function formatCommand(command, args) {
  return [command, ...args]
    .map((part) => (part.includes(" ") ? JSON.stringify(part) : part))
    .join(" ");
}

function run(
  command,
  args,
  {
    cwd = repoRoot,
    capture = false,
    acceptedExitCodes = [0],
    env = toolEnv,
    quiet = false,
  } = {},
) {
  if (!quiet) console.log(`> ${formatCommand(command, args)}`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (!acceptedExitCodes.includes(result.status)) {
    const detail = capture
      ? `\n${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd()
      : "";
    throw new Error(
      `${formatCommand(command, args)} failed with exit code ${result.status}${detail}`,
    );
  }
  return capture ? (result.stdout ?? "").trim() : "";
}

function pnpm(args, options) {
  return run(nodeExe, [pnpmCli, ...args], options);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function queryRegistry(path) {
  const result = spawnSync("reg.exe", ["query", path, "/ve"], {
    cwd: repoRoot,
    env: toolEnv,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (![0, 1].includes(result.status)) {
    throw new Error(
      `reg.exe query ${path} failed with exit code ${result.status}`,
    );
  }
  return { exists: result.status === 0, output: result.stdout ?? "" };
}

function assertRegistryValue(path, expectedValue) {
  const result = queryRegistry(path);
  assert.equal(result.exists, true, `Registry key is missing: ${path}`);
  assert.ok(
    result.output.toLowerCase().includes(expectedValue.toLowerCase()),
    `Registry key ${path} does not point to ${expectedValue}`,
  );
}

function assertRegistryMissing(path) {
  assert.equal(
    queryRegistry(path).exists,
    false,
    `Registry key still exists after uninstall: ${path}`,
  );
}

const rootPackage = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
);
const pnpmVersion = rootPackage.packageManager?.match(/^pnpm@(.+)$/)?.[1];
if (!pnpmVersion) {
  throw new Error("package.json must pin pnpm in packageManager");
}
const extensionPackage = JSON.parse(
  readFileSync(join(repoRoot, "packages", "extension", "package.json"), "utf8"),
);
const extensionIds = JSON.parse(
  readFileSync(join(repoRoot, "config", "extension-ids.json"), "utf8"),
);
const version = extensionPackage.version;
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error("LOCALAPPDATA is not set");

const installRoot = join(localAppData, "Tailscale", "BrowserExt");
const stagedHelper = join(installRoot, "installer", "tailscale-browser-ext.exe");
const runtimeHelper = join(installRoot, "tailscale-browser-ext.exe");
const chromeManifestPath = join(
  installRoot,
  `${extensionIds.chromeNativeHostId}.json`,
);
const firefoxManifestPath = join(
  installRoot,
  `${extensionIds.firefoxNativeHostId}.json`,
);
const registryPaths = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${extensionIds.chromeNativeHostId}`,
  `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${extensionIds.chromeNativeHostId}`,
  `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${extensionIds.chromeNativeHostId}`,
  `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${extensionIds.chromeNativeHostId}`,
  `HKCU\\Software\\Vivaldi\\NativeMessagingHosts\\${extensionIds.chromeNativeHostId}`,
  `HKCU\\Software\\Opera Software\\Opera Stable\\NativeMessagingHosts\\${extensionIds.chromeNativeHostId}`,
];
const firefoxRegistryPath =
  `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${extensionIds.firefoxNativeHostId}`;

function assertInstalledState() {
  for (const path of [
    helperExe,
    msiPath,
    stagedHelper,
    runtimeHelper,
    chromeManifestPath,
    firefoxManifestPath,
  ]) {
    assert.equal(existsSync(path), true, `Installed file is missing: ${path}`);
  }

  const expectedHash = sha256(helperExe);
  assert.equal(sha256(stagedHelper), expectedHash, "MSI staged a different helper");
  assert.equal(sha256(runtimeHelper), expectedHash, "Runtime helper copy differs");

  const chromeManifest = JSON.parse(readFileSync(chromeManifestPath, "utf8"));
  assert.equal(chromeManifest.name, extensionIds.chromeNativeHostId);
  assert.equal(chromeManifest.type, "stdio");
  assert.equal(
    resolve(chromeManifest.path).toLowerCase(),
    resolve(runtimeHelper).toLowerCase(),
  );
  assert.deepEqual(chromeManifest.allowed_origins, [
    `chrome-extension://${extensionIds.chromeExtensionId}/`,
  ]);

  const firefoxManifest = JSON.parse(readFileSync(firefoxManifestPath, "utf8"));
  assert.equal(firefoxManifest.name, extensionIds.firefoxNativeHostId);
  assert.equal(firefoxManifest.type, "stdio");
  assert.equal(
    resolve(firefoxManifest.path).toLowerCase(),
    resolve(runtimeHelper).toLowerCase(),
  );
  assert.deepEqual(firefoxManifest.allowed_extensions, [
    extensionIds.firefoxAddonId,
  ]);

  for (const path of registryPaths) {
    assertRegistryValue(path, chromeManifestPath);
  }
  assertRegistryValue(firefoxRegistryPath, firefoxManifestPath);

  const installedVersion = run(runtimeHelper, ["-version"], { capture: true });
  assert.equal(installedVersion, version, "Installed helper version is incorrect");
}

function assertUninstalledState() {
  for (const path of [
    stagedHelper,
    runtimeHelper,
    `${runtimeHelper}.old`,
    chromeManifestPath,
    firefoxManifestPath,
  ]) {
    assert.equal(existsSync(path), false, `File remains after uninstall: ${path}`);
  }
  for (const path of registryPaths) assertRegistryMissing(path);
  assertRegistryMissing(firefoxRegistryPath);
}

async function verifyNativeMessaging(extensionDir) {
  const { launch } = await import("./launch.mjs");
  const launched = await launch(extensionDir, { browserName: "chrome" });
  const pageErrors = [];

  try {
    const page = await launched.openPopup({
      beforeNavigate(targetPage) {
        targetPage.on("pageerror", (error) => pageErrors.push(error.message));
        targetPage.on("console", (message) => {
          if (message.type() === "error") pageErrors.push(message.text());
        });
      },
    });
    await page.waitForSelector("body", { timeout: 15_000 });

    const workerTarget = await launched.browser.waitForTarget(
      (target) =>
        target.type() === "service_worker" &&
        target.url().startsWith(`chrome-extension://${launched.extensionId}/`),
      { timeout: 30_000 },
    );
    const worker = await workerTarget.worker();
    assert.ok(worker, "Chrome extension service worker was not available");

    const procRunning = await worker.evaluate(
      ({ hostName }) =>
        new Promise((resolveMessage, rejectMessage) => {
          let settled = false;
          let port;
          const finish = (callback) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            callback();
          };
          const timeoutId = setTimeout(() => {
            finish(() => rejectMessage(new Error("Native host handshake timed out")));
          }, 30_000);

          try {
            port = chrome.runtime.connectNative(hostName);
          } catch (error) {
            finish(() => rejectMessage(error));
            return;
          }

          port.onMessage.addListener((message) => {
            if (message?.cmd !== "procRunning") return;
            finish(() => {
              port.disconnect();
              if (!message.procRunning) {
                rejectMessage(new Error("Native host sent an empty procRunning reply"));
              } else if (message.procRunning.error) {
                rejectMessage(new Error(message.procRunning.error));
              } else {
                resolveMessage(message.procRunning);
              }
            });
          });
          port.onDisconnect.addListener(() => {
            const reason = chrome.runtime.lastError?.message;
            finish(() =>
              rejectMessage(
                new Error(reason ?? "Native host disconnected before its handshake"),
              ),
            );
          });
        }),
      { hostName: extensionIds.chromeNativeHostId },
    );

    assert.equal(procRunning.version, version, "Native host version mismatch");
    assert.ok(Number.isInteger(procRunning.pid) && procRunning.pid > 0);
    assert.ok(Number.isInteger(procRunning.port) && procRunning.port > 0);
    assert.equal(procRunning.supportsPingPeer, true);
    assert.equal(procRunning.supportsLogin, true);
    assert.equal(procRunning.supportsCustomControlURL, true);
    await delay(1_500);
    await page.waitForSelector("#root .view", { timeout: 30_000 });
    const popupText = await page.evaluate(() => document.body.innerText);
    for (const unexpected of [
      "Quick Setup",
      "Update Available",
      "Unable to reach the helper app.",
    ]) {
      assert.equal(
        popupText.includes(unexpected),
        false,
        `Extension popup reported an integration failure: ${unexpected}`,
      );
    }
    assert.equal(
      await page.$(".error-details"),
      null,
      "Extension popup rendered helper error recovery",
    );
    assert.deepEqual(
      pageErrors,
      [],
      "Extension popup reported a console or page error",
    );
  } finally {
    await launched.browser.close();
  }
}

async function stopNativeHostProcesses() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const output = run(
      "tasklist.exe",
      ["/FI", "IMAGENAME eq tailscale-browser-ext.exe", "/NH"],
      { capture: true, quiet: true },
    );
    if (!output.toLowerCase().includes("tailscale-browser-ext.exe")) return;
    await delay(500);
  }

  run("taskkill.exe", ["/F", "/IM", "tailscale-browser-ext.exe"], {
    acceptedExitCodes: [0, 1, 128],
    quiet: true,
  });
}

function runMsi(action, logPath) {
  run(
    "msiexec.exe",
    [action, msiPath, "/qn", "/norestart", "/l*v", logPath],
    { acceptedExitCodes: [0, 3010] },
  );
}

async function main() {
  mkdirSync(distDir, { recursive: true });

  console.log("\n==> Install workspace dependencies");
  if (!existsSync(pnpmCli)) {
    run(nodeExe, [
      npmCli,
      "install",
      "--global",
      "--prefix",
      pnpmDir,
      `pnpm@${pnpmVersion}`,
    ]);
  }
  pnpm(["install", "--frozen-lockfile"]);

  console.log("\n==> Run Windows Go tests");
  run(goExe, ["test", "./..."], { cwd: join(repoRoot, "host") });

  console.log("\n==> Build Windows helper");
  const tailscaleVersion = run(
    goExe,
    ["list", "-m", "-f", "{{.Version}}", "tailscale.com"],
    { cwd: join(repoRoot, "host"), capture: true },
  ).replace(/^v/, "");
  const ldflags = [
    "-s",
    "-w",
    `-X main.version=${version}`,
    `-X tailscale.com/version.shortStamp=${tailscaleVersion}`,
    `-X tailscale.com/version.longStamp=${tailscaleVersion}`,
  ].join(" ");
  run(
    goExe,
    ["build", "-trimpath", "-ldflags", ldflags, "-o", helperExe, "."],
    { cwd: join(repoRoot, "host") },
  );

  console.log("\n==> Build unmodified Chrome extension");
  pnpm(["validate:ids"]);
  pnpm(["build:chrome"]);
  pnpm(["exec", "puppeteer", "browsers", "install", "chrome"]);
  const extensionDir = join(
    repoRoot,
    "packages",
    "extension",
    ".output",
    "chrome-mv3",
  );
  assert.equal(existsSync(extensionDir), true, "Chrome extension build is missing");

  console.log("\n==> Build Windows MSI");
  if (!existsSync(wixExe)) {
    mkdirSync(wixDir, { recursive: true });
    run(dotnetExe, [
      "tool",
      "install",
      "wix",
      "--tool-path",
      wixDir,
      "--version",
      "6.0.2",
    ]);
  }
  run(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(repoRoot, "packaging", "windows", "build-msi.ps1"),
      "-Version",
      version,
      "-HelperExe",
      helperExe,
      "-OutPath",
      msiPath,
    ],
  );

  let installed = false;
  let failure;
  try {
    console.log("\n==> Install MSI and verify Windows integration");
    runMsi("/i", installLog);
    installed = true;
    assertInstalledState();

    console.log("\n==> Verify real Chrome native-host handshake");
    await verifyNativeMessaging(extensionDir);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await stopNativeHostProcesses();
    } catch (cleanupError) {
      failure = failure
        ? new AggregateError(
            [failure, cleanupError],
            "Windows E2E failed and native-host cleanup also failed",
          )
        : cleanupError;
    }
    if (installed) {
      try {
        console.log("\n==> Uninstall MSI and verify cleanup");
        runMsi("/x", uninstallLog);
        assertUninstalledState();
      } catch (cleanupError) {
        failure = failure
          ? new AggregateError(
              [failure, cleanupError],
              "Windows E2E failed and MSI cleanup also failed",
            )
          : cleanupError;
      }
    }
  }

  if (failure) throw failure;
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? String(error));
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      console.error(nested.stack ?? nested.message ?? String(nested));
    }
  }
  process.exitCode = 1;
});
