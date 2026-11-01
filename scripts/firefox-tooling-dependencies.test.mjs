import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const extensionRequire = createRequire(new URL('../packages/extension/package.json', import.meta.url));
const webExtRequire = createRequire(extensionRequire.resolve('web-ext'));
const wxtRequire = createRequire(extensionRequire.resolve('wxt'));
const webExtRunRequire = createRequire(wxtRequire.resolve('web-ext-run'));
const addonRequire = createRequire(webExtRequire.resolve('addons-linter'));
const merge = addonRequire('./deepmerge.cjs');
const { createInstance } = addonRequire('addons-linter');
const { loadESLint } = addonRequire('eslint');

for (const [name, requireFrom] of [['web-ext', webExtRequire], ['web-ext-run', webExtRunRequire]]) {
  test(`${name} filters extension files with the patched glob matcher`, async () => {
    const { default: multimatch } = await import(requireFrom.resolve('multimatch'));
    const files = ['src/background.js', 'src/background.test.js', 'src/popup.css', '.hidden.js', 'manifest.json'];
    assert.deepEqual(
      multimatch(files, ['**/*.{js,css}', '!**/*.test.js'], { dot: true }),
      ['src/background.js', 'src/popup.css', '.hidden.js'],
    );
    assert.deepEqual(multimatch(files, '*.JS', { matchBase: true, nocase: true }), [
      'src/background.js', 'src/background.test.js',
    ]);
  });
}

for (const useFlatConfig of [true, false]) {
  test(`ESLint ${useFlatConfig ? 'flat' : 'legacy'} config keeps file overrides and exclusions`, async () => {
    const ESLint = await loadESLint({ useFlatConfig });
    const rules = { 'no-eval': 'error' };
    const eslint = new ESLint(useFlatConfig ? {
      overrideConfigFile: true,
      overrideConfig: [{ files: ['**/*.js'], ignores: ['**/skip.js'], rules }],
    } : {
      useEslintrc: false,
      overrideConfig: { overrides: [{ files: ['**/*.js'], excludedFiles: ['**/skip.js'], rules }] },
    });
    const [checked] = await eslint.lintText('eval("1 + 1");', { filePath: 'scripts/checked.js' });
    const [excluded] = await eslint.lintText('eval("1 + 1");', { filePath: 'scripts/skip.js' });
    assert.deepEqual(checked.messages.map(message => message.ruleId), ['no-eval']);
    assert.deepEqual(excluded.messages, []);
  });
}

for (const side of ['target', 'source']) {
  test(`schema merging rejects prototype keys in the ${side} without mutating input`, () => {
    const payload = JSON.parse(`{
      "__proto__": {"poisoned": true},
      "constructor": {"prototype": {"poisoned": true}},
      "nested": {"__proto__": {"poisoned": true}, "value": 1},
      "items": [{"__proto__": {"poisoned": true}, "value": 2}]
    }`);
    const original = JSON.stringify(payload);
    const result = side === 'target' ? merge(payload, { safe: true }) : merge({ safe: true }, payload);
    assert.deepEqual(result, { nested: { value: 1 }, items: [{ value: 2 }], safe: true });
    for (const object of [result, result.nested, result.items[0]]) {
      assert.equal(Object.getPrototypeOf(object), Object.prototype);
      assert.equal(object.poisoned, undefined);
      assert.equal(Object.hasOwn(object, '__proto__'), false);
    }
    assert.notEqual(result.nested, payload.nested);
    assert.notEqual(result.items[0], payload.items[0]);
    assert.equal(JSON.stringify(payload), original);
    assert.equal({}.poisoned, undefined);
  });
}

const manifests = [
  ['Manifest V2', {}, true],
  ['Manifest V3 permissions', { manifest_version: 3, permissions: ['storage', 'alarms'] }, true],
  ['static theme', { theme: { colors: { frame: '#000000', tab_background_text: '#ffffff' } } }, true],
  ['unsupported manifest version', { manifest_version: 1 }, false],
  ['invalid base field', { name: 12 }, false],
  ['invalid theme color', { theme: { colors: { frame: 12 } } }, false],
];

for (const [name, overrides, valid] of manifests) {
  test(`patched Firefox linter ${valid ? 'accepts' : 'rejects'} ${name}`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'tailchrome-linter-dependencies-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
      manifest_version: 2,
      name: 'Dependency regression fixture',
      version: '1.0',
      browser_specific_settings: { gecko: { id: 'dependency-fixture@tailchrome.invalid' } },
      ...overrides,
    }));
    const linter = createInstance({
      config: { _: [directory], logLevel: 'fatal', metadata: true, boring: true },
    });
    const output = await linter.run({ _console: { log() {}, warn() {}, error() {} } });
    assert.equal(output.errors.length === 0, valid, JSON.stringify(output.errors));
  });
}
