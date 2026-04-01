import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseTag = process.argv[2];

if (!releaseTag) {
  console.error("Usage: node scripts/validate-release-tag.mjs <tag>");
  process.exit(1);
}

if (!/^v\d+\.\d+\.\d+$/.test(releaseTag)) {
  console.error(`Release tag "${releaseTag}" must match v<semver>.`);
  process.exit(1);
}

const extensionPackage = JSON.parse(
  await readFile(resolve(root, "packages/extension/package.json"), "utf8"),
);
const expectedVersion = releaseTag.slice(1);

if (extensionPackage.version !== expectedVersion) {
  console.error(
    `Release tag mismatch: package version is ${extensionPackage.version}, tag is ${expectedVersion}.`,
  );
  process.exit(1);
}

console.log(`Release tag ${releaseTag} matches packages/extension/package.json.`);
