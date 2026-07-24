import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionIds = JSON.parse(
  await readFile(resolve(root, "config/extension-ids.json"), "utf8"),
);
const installGo = await readFile(resolve(root, "host/install.go"), "utf8");
const linuxPackage = await readFile(
  resolve(root, "packaging/linux/nfpm.yaml"),
  "utf8",
);
const chromeManifest = JSON.parse(
  await readFile(
    resolve(
      root,
      "packaging/linux/native-messaging/com.tailscale.browserext.chrome.json",
    ),
    "utf8",
  ),
);
const firefoxManifest = JSON.parse(
  await readFile(
    resolve(
      root,
      "packaging/linux/native-messaging/com.tailscale.browserext.firefox.json",
    ),
    "utf8",
  ),
);

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

const packagedHostPath = linuxPackage.match(
  /src:\s*dist\/tailscale-browser-ext-linux-amd64\s*\n\s*dst:\s*(\S+)/,
)?.[1];
const expectedChromeOrigin = `chrome-extension://${extensionIds.chromeExtensionId}/`;

if (!packagedHostPath) {
  mismatches.push("Missing Linux host destination in packaging/linux/nfpm.yaml");
} else {
  if (chromeManifest.path !== packagedHostPath) {
    mismatches.push(
      `Chrome Linux manifest path mismatch: expected "${packagedHostPath}", found "${chromeManifest.path}"`,
    );
  }
  if (firefoxManifest.path !== packagedHostPath) {
    mismatches.push(
      `Firefox Linux manifest path mismatch: expected "${packagedHostPath}", found "${firefoxManifest.path}"`,
    );
  }
}

if (chromeManifest.name !== extensionIds.chromeNativeHostId) {
  mismatches.push(
    `Chrome Linux manifest name mismatch: expected "${extensionIds.chromeNativeHostId}", found "${chromeManifest.name}"`,
  );
}
if (
  JSON.stringify(chromeManifest.allowed_origins) !==
  JSON.stringify([expectedChromeOrigin])
) {
  mismatches.push(
    `Chrome Linux allowed_origins mismatch: expected only "${expectedChromeOrigin}"`,
  );
}
if (firefoxManifest.name !== extensionIds.firefoxNativeHostId) {
  mismatches.push(
    `Firefox Linux manifest name mismatch: expected "${extensionIds.firefoxNativeHostId}", found "${firefoxManifest.name}"`,
  );
}
if (
  JSON.stringify(firefoxManifest.allowed_extensions) !==
  JSON.stringify([extensionIds.firefoxAddonId])
) {
  mismatches.push(
    `Firefox Linux allowed_extensions mismatch: expected only "${extensionIds.firefoxAddonId}"`,
  );
}

if (mismatches.length > 0) {
  console.error("Extension ID validation failed:");
  for (const mismatch of mismatches) {
    console.error(`- ${mismatch}`);
  }
  process.exit(1);
}

console.log("Extension IDs validated successfully.");
