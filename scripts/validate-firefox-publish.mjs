import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function getArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

async function assertExists(path, label) {
  try {
    await access(path, constants.F_OK);
  } catch {
    throw new Error(`${label} not found at ${path}`);
  }
}

const buildDir = resolve(
  root,
  getArg("--build-dir", "packages/extension/.output/firefox-mv3"),
);
const firefoxZip = resolve(
  root,
  getArg("--firefox-zip", "packages/extension/.output/firefox.zip"),
);
const firefoxSourcesZip = resolve(
  root,
  getArg("--firefox-sources-zip", "packages/extension/.output/firefox-sources.zip"),
);

const extensionIds = JSON.parse(
  await readFile(resolve(root, "config/extension-ids.json"), "utf8"),
);

await assertExists(firefoxZip, "Firefox ZIP");
await assertExists(firefoxSourcesZip, "Firefox sources ZIP");
await assertExists(resolve(buildDir, "manifest.json"), "Firefox manifest");

const manifest = JSON.parse(
  await readFile(resolve(buildDir, "manifest.json"), "utf8"),
);
const gecko = manifest.browser_specific_settings?.gecko;
const dataCollectionPermissions = gecko?.data_collection_permissions;

if (gecko?.id !== extensionIds.firefoxAddonId) {
  throw new Error(
    `Firefox add-on ID mismatch: expected "${extensionIds.firefoxAddonId}", found "${gecko?.id ?? "missing"}"`,
  );
}

if (
  !dataCollectionPermissions ||
  typeof dataCollectionPermissions !== "object"
) {
  throw new Error(
    "Firefox data_collection_permissions is missing. Complete the AMO privacy disclosure before publishing.",
  );
}

const categories = [
  ...(Array.isArray(dataCollectionPermissions.required)
    ? dataCollectionPermissions.required
    : []),
  ...(Array.isArray(dataCollectionPermissions.optional)
    ? dataCollectionPermissions.optional
    : []),
];

if (categories.length === 0) {
  throw new Error(
    "Firefox data_collection_permissions is empty. Replace the placeholder disclosure before publishing.",
  );
}

for (const category of categories) {
  if (
    typeof category !== "string" ||
    /todo|placeholder|tbd/i.test(category)
  ) {
    throw new Error(
      `Firefox data_collection_permissions contains a placeholder value: ${String(category)}`,
    );
  }
}

console.log("Firefox publish validation passed.");
