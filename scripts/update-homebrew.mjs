#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const releasePattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const assets = [
  "tailchrome-helper-macos.pkg",
  "tailscale-browser-ext-linux-arm64",
  "tailscale-browser-ext-linux-amd64",
];

export function parseChecksums(contents) {
  const checksums = new Map();
  for (const line of contents.trimEnd().split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match) throw new Error(`Invalid SHA256SUMS.txt entry: ${line}`);
    const [, checksum, asset] = match;
    if (checksums.has(asset)) throw new Error(`Duplicate checksum for ${asset}`);
    checksums.set(asset, checksum);
  }
  for (const asset of assets) {
    if (!checksums.has(asset)) throw new Error(`Missing checksum for ${asset}`);
  }
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

function updateVersion(contents, tag) {
  return replaceOnce(contents, /^  version "([0-9]+\.[0-9]+\.[0-9]+)"$/gm, (_, current) => {
    const previous = current.split(".").map(BigInt);
    const next = tag.slice(1).split(".").map(BigInt);
    const difference = next.findIndex((part, i) => part !== previous[i]);
    if (difference !== -1 && next[difference] < previous[difference]) {
      throw new Error(`Refusing to downgrade Homebrew from ${current} to ${tag}`);
    }
    return `  version "${tag.slice(1)}"`;
  });
}

// Read the final release manifest, never the pre-signing build outputs. Compute
// both updates before writing either file so invalid input cannot partially bump.
export async function updateHomebrew(tag, manifest, directory = root) {
  if (!releasePattern.test(tag) || tag.trim() !== tag) {
    throw new Error("Expected an explicit stable release tag such as v0.1.13");
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
    () => `  sha256 "${checksums.get(assets[0])}"`,
  );
  let formula = updateVersion(originalFormula, tag);
  for (const asset of assets.slice(1)) {
    formula = replaceOnce(
      formula,
      new RegExp(`(url "[^"\\n]+/${asset}",\\n +using: :nounzip\\n +sha256 ")[0-9a-f]{64}"`, "g"),
      (_, prefix) => `${prefix}${checksums.get(asset)}"`,
    );
  }
  await writeFile(caskPath, cask);
  await writeFile(formulaPath, formula);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [tag, manifestPath, ...extra] = process.argv.slice(2);
    if (!tag || !manifestPath || extra.length) {
      throw new Error("Usage: node scripts/update-homebrew.mjs <vX.Y.Z> <SHA256SUMS.txt>");
    }
    await updateHomebrew(tag, await readFile(manifestPath, "utf8"));
    console.log(`Updated the Homebrew cask and formula to ${tag}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
