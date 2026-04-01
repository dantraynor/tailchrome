import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionIds = JSON.parse(
  await readFile(resolve(root, "config/extension-ids.json"), "utf8"),
);
const installGo = await readFile(resolve(root, "host/install.go"), "utf8");

const checks = [
  {
    label: "chromeExtensionId",
    regex: /const chromeWebStoreExtensionID = "([^"]+)"/,
  },
  {
    label: "firefoxAddonId",
    regex: /const firefoxExtensionID = "([^"]+)"/,
  },
  {
    label: "chromeNativeHostId",
    regex: /const manifestNameChrome = "([^"]+)"/,
  },
  {
    label: "firefoxNativeHostId",
    regex: /const manifestNameFirefox = "([^"]+)"/,
  },
];

const mismatches = checks.flatMap(({ label, regex }) => {
  const match = installGo.match(regex);
  const actual = match?.[1];
  const expected = extensionIds[label];

  if (!actual) {
    return [`Missing ${label} constant in host/install.go`];
  }
  if (actual !== expected) {
    return [`${label} mismatch: expected "${expected}", found "${actual}"`];
  }
  return [];
});

if (mismatches.length > 0) {
  console.error("Extension ID validation failed:");
  for (const mismatch of mismatches) {
    console.error(`- ${mismatch}`);
  }
  process.exit(1);
}

console.log("Extension IDs validated successfully.");
