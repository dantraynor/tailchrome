import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

// addons-linter is reached through web-ext, the Firefox lint/review tooling.
const extensionRequire = createRequire(new URL('../packages/extension/package.json', import.meta.url));
const webExtRequire = createRequire(extensionRequire.resolve('web-ext'));
const linterEntry = webExtRequire.resolve('addons-linter');
const linterRequire = createRequire(linterEntry);
const bundle = readFileSync(join(dirname(linterEntry), 'addons-linter.js'), 'utf8');

/** Loads the deepmerge copy that the patch inlines into the webpack bundle. */
function inlinedDeepmerge() {
  const start = bundle.indexOf('// Inlined deepmerge 4.3.1');
  assert.notEqual(start, -1, 'patched addons-linter must inline deepmerge');
  const end = bundle.indexOf('\n/***/ })', start);
  assert.notEqual(end, -1, 'inlined deepmerge module must be terminated');
  const module = { exports: {} };
  new Function('module', bundle.slice(start, end))(module);
  return module.exports;
}

test('addons-linter no longer loads the deepmerge package', () => {
  assert.doesNotMatch(bundle, /require\("deepmerge"\)/);
  const lockfile = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
  assert.doesNotMatch(lockfile, /^\s+deepmerge@/m, 'deepmerge must not be installed');
});

test('inlined deepmerge blocks prototype poisoning (GHSA-gcqx-w48m-w2h4)', () => {
  const deepmerge = inlinedDeepmerge();
  const poisoned = () => JSON.parse('{"__proto__": {"polluted": "yes"}, "a": 1}');

  // A target carrying an own "__proto__" key poisoned the result in 4.3.1.
  for (const merged of [deepmerge(poisoned(), { b: 2 }), deepmerge(poisoned(), poisoned())]) {
    assert.equal(merged.polluted, undefined);
    assert.equal(Object.getPrototypeOf(merged), Object.prototype);
    assert.deepEqual(Object.getOwnPropertyDescriptor(merged, '__proto__')?.value, { polluted: 'yes' });
  }
  // Source-side keys were already skipped by 4.3.1's own guard.
  const nested = deepmerge({ x: 1 }, { nested: poisoned() }).nested;
  assert.equal(nested.polluted, undefined);
  assert.equal(Object.getPrototypeOf(nested), Object.prototype);
  assert.equal({}.polluted, undefined);
});

test('inlined deepmerge keeps deepmerge 4.3.1 merge semantics', () => {
  const deepmerge = inlinedDeepmerge();
  const date = new Date(0);
  assert.deepEqual(
    deepmerge({ a: { b: 1, list: [1] }, d: date }, { a: { c: 2, list: [2] }, e: /x/ }),
    { a: { b: 1, c: 2, list: [1, 2] }, d: date, e: /x/ },
  );
  assert.deepEqual(deepmerge({ list: [1, 2] }, { list: [2, 3] }, { arrayMerge: (_t, s) => s }), { list: [2, 3] });
  assert.deepEqual(deepmerge.all([{ a: 1 }, { b: 2 }, { a: 3 }]), { a: 3, b: 2 });
  assert.deepEqual(deepmerge({ a: 1 }, [1]), [1]);
});

async function lintManifest(manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'tailchrome-addons-linter-'));
  try {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    const linter = linterRequire(linterEntry).createInstance({
      config: { _: [dir], logLevel: 'fatal', stack: false, pretty: false, warningsAsErrors: false, metadata: false, output: 'none', boring: true, selfHosted: false },
      runAsBinary: false,
    });
    return await linter.run();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('addons-linter still validates manifests against its merged schemas', async () => {
  const gecko = { id: 'deepmerge-check@tailchrome.test', data_collection_permissions: { required: ['none'] } };
  const base = { manifest_version: 3, name: 'deepmerge check', version: '1.0', browser_specific_settings: { gecko } };

  // Both the extension and theme schemas are assembled with deepPatch.
  const extension = await lintManifest({ ...base, permissions: ['tabs'] });
  assert.deepEqual(extension.errors.map((m) => m.code), []);
  const theme = await lintManifest({ ...base, theme: { colors: { frame: '#000000', tab_background_text: '#ffffff' } } });
  assert.deepEqual(theme.errors.map((m) => m.code), []);

  const invalid = await lintManifest({
    ...base,
    permissions: ['notARealPermission'],
    browser_specific_settings: { gecko: { ...gecko, id: 'not-an-id' } },
  });
  const codes = invalid.errors.map((m) => m.code);
  assert.ok(codes.includes('JSON_INVALID'), `expected schema errors, got ${codes.join(', ')}`);
});
