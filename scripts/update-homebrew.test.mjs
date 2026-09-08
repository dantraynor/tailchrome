import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseChecksums, updateHomebrew } from "./update-homebrew.mjs";

const assets = [
  "tailchrome-helper-macos.pkg",
  "tailscale-browser-ext-linux-arm64",
  "tailscale-browser-ext-linux-amd64",
];
const hashes = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
const manifest = assets.map((asset, i) => `${hashes[i]}  ${asset}\n`).join("");
const sourceHash = "d".repeat(64);

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tailchrome-homebrew-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const folder of ["Casks", "Formula"]) {
    await mkdir(path.join(directory, folder));
    const definition = await readFile(new URL(`../${folder}/tailchrome.rb`, import.meta.url), "utf8");
    await writeFile(path.join(directory, folder, "tailchrome.rb"), definition
      .replace(/^  version ".*"$/m, '  version "0.1.13"')
      .replace(/\/tags\/v\d+\.\d+\.\d+\.tar\.gz/, "/tags/v0.1.13.tar.gz"));
  }
  return directory;
}

async function definitions(directory) {
  return Promise.all(["Casks", "Formula"].map((folder) => readFile(path.join(directory, folder, "tailchrome.rb"), "utf8")));
}

test("pins the cask asset and source archive independently and is idempotent", async (t) => {
  const directory = await fixture(t);
  await updateHomebrew("v0.1.14", manifest, sourceHash, directory);
  const updated = await definitions(directory);
  assert.match(updated[0], /version "0\.1\.14"/);
  assert.match(updated[0], new RegExp(`sha256 "${hashes[0]}"`));
  assert.match(updated[1], /archive\/refs\/tags\/v0\.1\.14\.tar\.gz/);
  assert.match(updated[1], new RegExp(`sha256 "${sourceHash}"`));
  assert.doesNotMatch(updated[1], /releases\/download|using: :nounzip/);
  assert.match(updated[0], /releases\/download\/v#\{version\}/);
  await updateHomebrew("v0.1.14", manifest, sourceHash, directory);
  assert.deepEqual(await definitions(directory), updated);
});

test("compares version components numerically", async (t) => {
  const directory = await fixture(t);
  await updateHomebrew("v0.2.0", manifest, sourceHash, directory);
  await updateHomebrew("v0.10.0", manifest, sourceHash, directory);
  const updated = await definitions(directory);
  assert.match(updated[0], /version "0\.10\.0"/);
  assert.match(updated[1], /\/tags\/v0\.10\.0\.tar\.gz/);
});

test("rejects invalid tags and downgrades without changing either definition", async (t) => {
  const directory = await fixture(t);
  const original = await definitions(directory);
  for (const tag of ["latest", "0.1.14", "v0.1.14-beta.1", "v01.1.14", "v0.1.14\n", 'v0.1.14"', "v0.1.12", "v0.0.99"]) {
    await assert.rejects(updateHomebrew(tag, manifest, sourceHash, directory));
    assert.deepEqual(await definitions(directory), original);
  }
});

test("rejects malformed, duplicate, and missing checksums before writing", async (t) => {
  const directory = await fixture(t);
  const original = await definitions(directory);
  for (const invalid of [
    "",
    manifest.replace(hashes[0], "not-a-checksum"),
    manifest.replace(hashes[0], "a".repeat(63)),
    manifest.replace(assets[0], `../${assets[0]}`),
    manifest + `${hashes[0]}  ${assets[0]}\n`,
    manifest.replace(`${hashes[0]}  ${assets[0]}\n`, ""),
  ]) {
    await assert.rejects(updateHomebrew("v0.1.14", invalid, sourceHash, directory));
    assert.deepEqual(await definitions(directory), original);
  }
});

test("refuses to partially update when a definition's expected structure changes", async (t) => {
  const directory = await fixture(t);
  const formulaPath = path.join(directory, "Formula/tailchrome.rb");
  await writeFile(formulaPath, (await readFile(formulaPath, "utf8")).replace("archive/refs/tags", "archive/refs/heads"));
  const original = await definitions(directory);
  await assert.rejects(updateHomebrew("v0.1.14", manifest, sourceHash, directory), /Expected one match/);
  assert.deepEqual(await definitions(directory), original);
});

test("refuses to downgrade a formula that is newer than the cask", async (t) => {
  const directory = await fixture(t);
  const formulaPath = path.join(directory, "Formula/tailchrome.rb");
  await writeFile(formulaPath, (await readFile(formulaPath, "utf8")).replace("v0.1.13.tar.gz", "v0.2.0.tar.gz"));
  const original = await definitions(directory);
  await assert.rejects(updateHomebrew("v0.1.14", manifest, sourceHash, directory), /Refusing to downgrade/);
  assert.deepEqual(await definitions(directory), original);
});

test("rejects invalid source archive checksums without writing either definition", async (t) => {
  const directory = await fixture(t);
  const original = await definitions(directory);
  for (const invalid of [undefined, "", "not-a-checksum", "a".repeat(63), sourceHash + "\n"]) {
    await assert.rejects(updateHomebrew("v0.1.14", manifest, invalid, directory), /source archive/);
    assert.deepEqual(await definitions(directory), original);
  }
});

test("source formula updates do not require raw binary release assets", async (t) => {
  const directory = await fixture(t);
  await updateHomebrew("v0.1.14", `${hashes[0]}  ${assets[0]}\n`, sourceHash, directory);
  assert.match((await definitions(directory))[1], new RegExp(`sha256 "${sourceHash}"`));
});

test("accepts other final release assets and CRLF manifests", () => {
  const checksums = parseChecksums((manifest + `${"d".repeat(64)}  chrome.zip\n`).replaceAll("\n", "\r\n"));
  assert.equal(checksums.get(assets[1]), hashes[1]);
  assert.equal(checksums.get("chrome.zip"), "d".repeat(64));
});
