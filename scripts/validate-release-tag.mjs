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
const sharedPackage = JSON.parse(
  await readFile(resolve(root, "packages/shared/package.json"), "utf8"),
);
const sharedConstants = await readFile(
  resolve(root, "packages/shared/src/constants.ts"),
  "utf8",
);
const expectedVersion = releaseTag.slice(1);
const hostVersion = sharedConstants.match(
  /EXPECTED_HOST_VERSION\s*=\s*"([^"]+)"/,
)?.[1];

const mismatches = [
  ["packages/extension/package.json", extensionPackage.version],
  ["packages/shared/package.json", sharedPackage.version],
  ["packages/shared/src/constants.ts EXPECTED_HOST_VERSION", hostVersion],
].flatMap(([source, actual]) =>
  actual === expectedVersion
    ? []
    : [`${source}: expected ${expectedVersion}, found ${actual ?? "missing"}`],
);

if (mismatches.length > 0) {
  console.error(`Release tag ${releaseTag} does not match every version source:`);
  for (const mismatch of mismatches) console.error(`- ${mismatch}`);
  process.exit(1);
}

console.log(`Release tag ${releaseTag} matches every version source.`);
