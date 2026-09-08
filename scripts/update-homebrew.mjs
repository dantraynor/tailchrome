#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const releasePattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const caskAsset = "tailchrome-helper-macos.pkg";

export function parseChecksums(contents) {
  const checksums = new Map();
  for (const line of contents.trimEnd().split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match) throw new Error(`Invalid SHA256SUMS.txt entry: ${line}`);
    const [, checksum, asset] = match;
    if (checksums.has(asset)) throw new Error(`Duplicate checksum for ${asset}`);
    checksums.set(asset, checksum);
  }
  if (!checksums.has(caskAsset)) throw new Error(`Missing checksum for ${caskAsset}`);
  return checksums;
}

function replaceOnce(contents, pattern, replacement) {
  let matches = 0;
  const result = contents.replace(pattern, (...args) => {
    matches += 1;
    return replacement(...args);
  });
  if (matches !== 1) throw new Error(`Expected one match for ${pattern}, found ${matches}`);
  return result;
}

function checkUpgrade(current, tag) {
  const previous = current.split(".").map(BigInt);
  const next = tag.slice(1).split(".").map(BigInt);
  const difference = next.findIndex((part, i) => part !== previous[i]);
  if (difference !== -1 && next[difference] < previous[difference]) {
    throw new Error(`Refusing to downgrade Homebrew from ${current} to ${tag}`);
  }
}

function updateVersion(contents, tag) {
  return replaceOnce(contents, /^  version "([0-9]+\.[0-9]+\.[0-9]+)"$/gm, (_, current) => {
    checkUpgrade(current, tag);
    return `  version "${tag.slice(1)}"`;
  });
}

// The cask uses the final release manifest; the formula pins the tag's source
// archive separately. Compute both updates before writing either definition.
export async function updateHomebrew(tag, manifest, sourceSha256, directory = root) {
  if (!releasePattern.test(tag) || tag.trim() !== tag) {
    throw new Error("Expected an explicit stable release tag such as v0.1.13");
  }
  if (!/^[0-9a-f]{64}$/.test(sourceSha256) || sourceSha256.trim() !== sourceSha256) {
    throw new Error("Expected the SHA-256 of the release source archive");
  }
  const checksums = parseChecksums(manifest);
  const caskPath = path.join(directory, "Casks/tailchrome.rb");
  const formulaPath = path.join(directory, "Formula/tailchrome.rb");
  const [originalCask, originalFormula] = await Promise.all([
    readFile(caskPath, "utf8"),
    readFile(formulaPath, "utf8"),
  ]);
  const cask = replaceOnce(
    updateVersion(originalCask, tag),
    /^  sha256 "[0-9a-f]{64}"$/gm,
    () => `  sha256 "${checksums.get(caskAsset)}"`,
  );
  let formula = replaceOnce(
    originalFormula,
    /^  url "https:\/\/github\.com\/dantraynor\/tailchrome\/archive\/refs\/tags\/v([0-9]+\.[0-9]+\.[0-9]+)\.tar\.gz"$/gm,
    (_, current) => {
      checkUpgrade(current, tag);
      return `  url "https://github.com/dantraynor/tailchrome/archive/refs/tags/${tag}.tar.gz"`;
    },
  );
  formula = replaceOnce(formula, /^  sha256 "[0-9a-f]{64}"$/gm, () => `  sha256 "${sourceSha256}"`);
  await writeFile(caskPath, cask);
  await writeFile(formulaPath, formula);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [tag, manifestPath, sourcePath, ...extra] = process.argv.slice(2);
    if (!tag || !manifestPath || !sourcePath || extra.length) {
      throw new Error("Usage: node scripts/update-homebrew.mjs <vX.Y.Z> <SHA256SUMS.txt> <source.tar.gz>");
    }
    const sourceSha256 = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
    await updateHomebrew(tag, await readFile(manifestPath, "utf8"), sourceSha256);
    console.log(`Updated the Homebrew cask and formula to ${tag}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
