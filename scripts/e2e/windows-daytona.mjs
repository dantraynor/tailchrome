#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Daytona } from "@daytona/sdk";
import { create as createTar } from "tar";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const snapshot = process.env.DAYTONA_WINDOWS_SNAPSHOT ?? "windows-medium";
const keepSandbox = process.env.KEEP_DAYTONA_SANDBOX === "true";
const keepFailedSandbox =
  process.env.KEEP_DAYTONA_SANDBOX_ON_FAILURE === "true";

function parseTtlMinutes(value = process.env.DAYTONA_E2E_TTL_MINUTES ?? "60") {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 240) {
    throw new Error(
      "DAYTONA_E2E_TTL_MINUTES must be an integer between 15 and 240",
    );
  }
  return minutes;
}

function git(args, { binary = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: binary ? "buffer" : "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${String(result.stderr).trim()}`,
    );
  }
  return result.stdout;
}

async function createSourceArchive(tempDir) {
  const output = git(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { binary: true },
  );
  const files = output
    .toString("utf8")
    .split("\0")
    .filter((file) => file && existsSync(resolve(repoRoot, file)));
  if (files.length === 0) throw new Error("No repository files found to upload");

  const archivePath = join(tempDir, "tailchrome-source.tgz");
  await createTar(
    {
      cwd: repoRoot,
      file: archivePath,
      gzip: true,
      noMtime: true,
      portable: true,
    },
    files,
  );
  return { archivePath, fileCount: files.length };
}

async function runRemoteCommand(
  sandbox,
  { label, command, timeoutSeconds },
) {
  const sessionId = `tailchrome-${randomUUID()}`;
  console.log(`\n==> ${label}`);
  await sandbox.process.createSession(sessionId);
  try {
    const response = await sandbox.process.executeSessionCommand(
      sessionId,
      { command, runAsync: true, suppressInputEcho: true },
      timeoutSeconds,
    );
    await sandbox.process.getSessionCommandLogs(
      sessionId,
      response.cmdId,
      (chunk) => process.stdout.write(chunk),
      (chunk) => process.stderr.write(chunk),
    );
    const completed = await sandbox.process.getSessionCommand(
      sessionId,
      response.cmdId,
    );
    if (completed.exitCode !== 0) {
      throw new Error(
        `${label} failed with exit code ${completed.exitCode ?? "unknown"}`,
      );
    }
  } finally {
    await sandbox.process.deleteSession(sessionId).catch(() => {});
  }
}

async function collectMsiLogs(sandbox) {
  const artifactDir = resolve(
    repoRoot,
    "dist/daytona-windows-e2e",
    sandbox.id,
  );
  const logs = ["msi-install.log", "msi-uninstall.log"];
  let downloaded = 0;

  for (const name of logs) {
    try {
      mkdirSync(artifactDir, { recursive: true });
      await sandbox.fs.downloadFile(
        `tailchrome/dist/${name}`,
        join(artifactDir, name),
        120,
      );
      downloaded += 1;
    } catch {
      // A log only exists after its corresponding MSI operation starts.
    }
  }

  if (downloaded > 0) {
    console.log(`MSI logs: ${artifactDir}`);
  } else {
    rmSync(artifactDir, { recursive: true, force: true });
  }
}

function conciseError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AggregateError) {
    return [message, ...error.errors.map((nested) => `- ${conciseError(nested)}`)].join(
      "\n",
    );
  }
  if (
    error?.statusCode === 403 &&
    message.toLowerCase().includes("windows sandboxes")
  ) {
    return (
      "Daytona Windows sandbox access is not enabled for this organization. " +
      "Ask Daytona support to enable Windows sandboxes, then rerun this command."
    );
  }
  if (process.env.DEBUG === "true" && error instanceof Error) {
    return error.stack ?? message;
  }
  return message;
}

async function main() {
  if (!process.env.DAYTONA_API_KEY) {
    throw new Error(
      "DAYTONA_API_KEY is not set. Inject it from your credential store locally " +
        "or configure the DAYTONA_API_KEY repository secret in CI.",
    );
  }

  const ttlMinutes = parseTtlMinutes();
  const daytona = new Daytona();
  const tempDir = mkdtempSync(join(tmpdir(), "tailchrome-daytona-e2e-"));
  let sandbox;
  let failure;

  try {
    const { archivePath, fileCount } = await createSourceArchive(tempDir);
    const shortSha = String(git(["rev-parse", "--short", "HEAD"])).trim();
    const sandboxName =
      `tailchrome-windows-e2e-${shortSha}-${Date.now().toString(36)}`.slice(
        0,
        63,
      );

    console.log(
      `Creating ${snapshot} sandbox (TTL ${ttlMinutes} minutes) for ${fileCount} source files...`,
    );
    sandbox = await daytona.create(
      {
        snapshot,
        name: sandboxName,
        labels: { repository: "tailchrome", purpose: "windows-e2e" },
        ephemeral: true,
        autoStopInterval: 0,
        ttlMinutes,
      },
      { timeout: 300 },
    );
    console.log(`Sandbox ready: ${sandbox.id}`);

    const archiveSize = statSync(archivePath).size;
    console.log(`Uploading source archive (${(archiveSize / 1024 / 1024).toFixed(1)} MiB)...`);
    await sandbox.fs.uploadFile(archivePath, "tailchrome-source.tgz", 900);

    await runRemoteCommand(sandbox, {
      label: "Extract source tree",
      timeoutSeconds: 300,
      command:
        "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass " +
        '-Command "$ErrorActionPreference = \'Stop\'; ' +
        "if (Test-Path 'tailchrome') { Remove-Item -Recurse -Force 'tailchrome' }; " +
        "New-Item -ItemType Directory -Path 'tailchrome' | Out-Null; " +
        "tar.exe -xzf 'tailchrome-source.tgz' -C 'tailchrome'; " +
        "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\"",
    });

    await runRemoteCommand(sandbox, {
      label: "Bootstrap pinned Windows toolchain",
      timeoutSeconds: 900,
      command:
        "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass " +
        '-File "tailchrome\\scripts\\e2e\\windows-bootstrap.ps1"',
    });

    await runRemoteCommand(sandbox, {
      label: "Run Windows installer and native-messaging E2E",
      timeoutSeconds: 2_400,
      command:
        "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass " +
        '-Command "$ErrorActionPreference = \'Stop\'; ' +
        "& 'tailchrome\\.tools\\node\\node.exe' " +
        "'tailchrome\\scripts\\e2e\\windows-system.mjs'; " +
        "exit $LASTEXITCODE\"",
    });

    console.log("\nWindows E2E passed.");
  } catch (error) {
    failure = error;
  } finally {
    if (sandbox) {
      await collectMsiLogs(sandbox).catch(() => {});
      const shouldKeep = keepSandbox || (failure && keepFailedSandbox);
      if (shouldKeep) {
        console.log(
          `Keeping sandbox ${sandbox.id}; Daytona will delete it after the configured TTL.`,
        );
      } else {
        console.log(`Deleting sandbox ${sandbox.id}...`);
        try {
          await daytona.delete(sandbox, 300, true);
        } catch (error) {
          const deletionError = new Error(
            `Sandbox deletion failed: ${conciseError(error)}`,
            { cause: error },
          );
          failure = failure
            ? new AggregateError(
                [failure, deletionError],
                "Windows E2E failed and sandbox deletion also failed",
              )
            : deletionError;
        }
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
    await daytona[Symbol.asyncDispose]();
  }

  if (failure) throw failure;
}

main().catch((error) => {
  console.error(`Windows E2E failed: ${conciseError(error)}`);
  process.exitCode = 1;
});
