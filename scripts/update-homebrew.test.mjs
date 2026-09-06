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

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tailchrome-homebrew-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const folder of ["Casks", "Formula"]) {
    await mkdir(path.join(directory, folder));
    const definition = await readFile(new URL(`../${folder}/tailchrome.rb`, import.meta.url), "utf8");
    await writeFile(path.join(directory, folder, "tailchrome.rb"), definition.replace(/^  version ".*"$/m, '  version "0.1.13"'));
  }
  return directory;
}

async function definitions(directory) {
  return Promise.all(["Casks", "Formula"].map((folder) => readFile(path.join(directory, folder, "tailchrome.rb"), "utf8")));
}

test("updates both definitions with the correct platform hashes and is idempotent", async (t) => {
  const directory = await fixture(t);
  await updateHomebrew("v0.1.14", manifest, directory);
  const updated = await definitions(directory);
  for (const definition of updated) assert.match(definition, /version "0\.1\.14"/);
  assert.match(updated[0], new RegExp(`sha256 "${hashes[0]}"`));
  for (let i = 1; i < assets.length; i++) {
    assert.match(updated[1], new RegExp(`${assets[i]}",\\n +using: :nounzip\\n +sha256 "${hashes[i]}"`));
  }
  assert.match(updated[0], /releases\/download\/v#\{version\}/);
  await updateHomebrew("v0.1.14", manifest, directory);
  assert.deepEqual(await definitions(directory), updated);
});

test("compares version components numerically", async (t) => {
  const directory = await fixture(t);
  await updateHomebrew("v0.2.0", manifest, directory);
  await updateHomebrew("v0.10.0", manifest, directory);
  for (const definition of await definitions(directory)) assert.match(definition, /version "0\.10\.0"/);
});

test("rejects invalid tags and downgrades without changing either definition", async (t) => {
  const directory = await fixture(t);
  const original = await definitions(directory);
  for (const tag of ["latest", "0.1.14", "v0.1.14-beta.1", "v01.1.14", "v0.1.14\n", 'v0.1.14"', "v0.1.12", "v0.0.99"]) {
    await assert.rejects(updateHomebrew(tag, manifest, directory));
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
    manifest.replace(`${hashes[1]}  ${assets[1]}\n`, ""),
  ]) {
    await assert.rejects(updateHomebrew("v0.1.14", invalid, directory));
    assert.deepEqual(await definitions(directory), original);
  }
});

test("refuses to partially update when a definition's expected structure changes", async (t) => {
  const directory = await fixture(t);
  const formulaPath = path.join(directory, "Formula/tailchrome.rb");
  await writeFile(formulaPath, (await readFile(formulaPath, "utf8")).replace("linux-arm64", "linux-aarch64"));
  const original = await definitions(directory);
  await assert.rejects(updateHomebrew("v0.1.14", manifest, directory), /Expected one match/);
  assert.deepEqual(await definitions(directory), original);
});

test("accepts other final release assets and CRLF manifests", () => {
  const checksums = parseChecksums((manifest + `${"d".repeat(64)}  chrome.zip\n`).replaceAll("\n", "\r\n"));
  assert.equal(checksums.get(assets[1]), hashes[1]);
  assert.equal(checksums.get("chrome.zip"), "d".repeat(64));
});
