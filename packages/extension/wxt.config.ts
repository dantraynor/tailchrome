import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type UserManifest } from "wxt";
import {
  firefoxDisclosure,
  isFirefoxDisclosureReady,
  type FirefoxDataCollectionPermissions,
} from "./config/firefox-disclosure";

interface ExtensionIds {
  chromeExtensionId: string;
  firefoxAddonId: string;
  chromeNativeHostId: string;
  firefoxNativeHostId: string;
}

interface TailchromeManifest extends UserManifest {
  browser_specific_settings?: NonNullable<UserManifest["browser_specific_settings"]> & {
    gecko?: NonNullable<
      NonNullable<UserManifest["browser_specific_settings"]>["gecko"]
    > & {
      data_collection_permissions?: FirefoxDataCollectionPermissions;
    };
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const sharedDir = resolve(__dirname, "../shared");
const extensionIds = JSON.parse(
  readFileSync(resolve(repoRoot, "config/extension-ids.json"), "utf8"),
) as ExtensionIds;

const chromeActionIcons = {
  "16": "icons/icon-16-offline.png",
  "32": "icons/icon-32-offline.png",
  "48": "icons/icon-48-offline.png",
  "128": "icons/icon-128-offline.png",
};

const extensionIcons = {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png",
};

const extensionDescription =
  "Access your tailnet from your browser. Run a full Tailscale node per browser profile without affecting system networking.";

export default defineConfig({
  srcDir: ".",
  entrypointsDir: "entrypoints",
  publicDir: "public",
  outDir: ".output",
  manifestVersion: 3,
  targetBrowsers: ["chrome", "firefox"],
  zip: {
    artifactTemplate: "{{browser}}.zip",
    sourcesTemplate: "firefox-sources.zip",
    sourcesRoot: repoRoot,
    // WXT walks the entire sourcesRoot unless paths are explicitly excluded.
    // Use an allowlist so the AMO source ZIP only contains extension rebuild inputs.
    excludeSources: ["**/*"],
    includeSources: [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
      "SOURCE_CODE_REVIEW.md",
      "config/extension-ids.json",
      "packages/extension/**",
      "packages/shared/**",
    ],
  },
  vite: () => ({
    resolve: {
      alias: {
        "@tailchrome/shared": resolve(sharedDir, "src"),
      },
    },
    server: {
      fs: {
        allow: [repoRoot, sharedDir],
      },
    },
  }),
  manifest: ({ browser }) => {
    const manifest: TailchromeManifest = {
      name: "Tailchrome",
      description: extensionDescription,
      host_permissions: ["<all_urls>"],
      permissions: [
        "proxy",
        "storage",
        "nativeMessaging",
        "contextMenus",
        ...(browser === "firefox" ? ["alarms"] : []),
      ],
      action: {
        default_icon: chromeActionIcons,
      },
      icons: extensionIcons,
    };

    if (browser === "chrome") {
      manifest.key =
        "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5/m925fPufiafHbegmZwPoowhf4XOlaEKseW/9Q3u47OQ6ALk/hSYqVOjvv2SZSVIVbVJs5CrfmjWqf65Y6Nf3EkkDYHiimLXifO1XekQMQWsp1KZNHR8ymKDyOE/BFFpl2QgQgfwvNLUYZv6z9+lS95UBZk4rkpm3qS3yFuMaShdURljE/DyrmelRQDCy8YJsoj2yyf4qkap3DCw5k2z5nRGxmw71E4JwavlKySIH5C+wCMo/EoHkjrS/uupbpTxvfTIuXYmmPhx3yyCwBazNrkNjNe5NQk1cLvUkrGvnzo8PO2Zx3Qh9qRZUtdMZ7p1xDzUZi37uePw6QT1xjKwQIDAQAB";
      return manifest;
    }

    manifest.browser_specific_settings = {
      gecko: {
        id: extensionIds.firefoxAddonId,
        strict_min_version: "140.0",
        ...(isFirefoxDisclosureReady(firefoxDisclosure)
          ? {
              data_collection_permissions:
                firefoxDisclosure.dataCollectionPermissions,
            }
          : {}),
      },
    };

    return manifest;
  },
});
