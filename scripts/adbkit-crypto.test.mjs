import assert from 'node:assert/strict';
import {
  constants,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  privateEncrypt,
  sign,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const extensionRequire = createRequire(new URL('../packages/extension/package.json', import.meta.url));
const webExtRequire = createRequire(extensionRequire.resolve('web-ext'));
const wxtRequire = createRequire(extensionRequire.resolve('wxt'));
const webExtRunRequire = createRequire(wxtRequire.resolve('web-ext-run'));
const adbkitEntry = webExtRequire.resolve('@devicefarmer/adbkit');
const adbkitRequire = createRequire(adbkitEntry);
const adbkitRoot = dirname(dirname(adbkitEntry));
const { default: adb } = adbkitRequire(adbkitEntry);
const { default: Socket } = adbkitRequire('./src/adb/tcpusb/socket.js');
const sha1Prefix = Buffer.from('3021300906052b0e03021a05000414', 'hex');

function fixture(exponent) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: exponent,
  });
  const jwk = publicKey.export({ format: 'jwk' });
  const modulus = Buffer.from(jwk.n, 'base64url');
  const struct = Buffer.alloc(12 + modulus.length * 2);
  struct.writeUInt32LE(modulus.length / 4);
  Buffer.from(modulus).reverse().copy(struct, 8);
  struct.writeUInt32LE(exponent, struct.length - 4);
  // n0inv and rr are acceleration fields ignored by adbkit's key parser.
  const androidKey = `${struct.toString('base64')} test@tailchrome`;
  const message = Buffer.from(`independent SHA-1 signing oracle for exponent ${exponent}`);
  const token = createHash('sha1').update(message).digest();
  // crypto.sign hashes the original message; ADB receives only its digest.
  const signature = sign('sha1', message, privateKey);
  return { publicKey, privateKey, jwk, struct, androidKey, token, signature };
}

const fixtures = [fixture(3), fixture(65537)];

function signPayload(privateKey, payload) {
  return privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, payload);
}

function parseSsh(output) {
  const [algorithm, encoded, comment] = output.trim().split(' ');
  assert.equal(algorithm, 'ssh-rsa');
  assert.equal(comment, 'adbkey');
  const wire = Buffer.from(encoded, 'base64');
  let offset = 0;
  const fields = Array.from({ length: 3 }, () => {
    const length = wire.readUInt32BE(offset);
    offset += 4;
    const field = wire.subarray(offset, offset + length);
    offset += length;
    assert.equal(field.length, length);
    return field;
  });
  assert.equal(offset, wire.length);
  assert.equal(fields[0].toString(), 'ssh-rsa');
  const unsigned = (bytes) => {
    assert.ok(bytes[0] < 0x80, 'SSH integers must remain positive');
    return (bytes[0] === 0 ? bytes.subarray(1) : bytes).toString('base64url');
  };
  return { kty: 'RSA', e: unsigned(fields[1]), n: unsigned(fields[2]) };
}

test('both Firefox tooling paths load patched adbkit without node-forge', () => {
  assert.equal(webExtRunRequire.resolve('@devicefarmer/adbkit'), adbkitEntry);
  assert.equal(adbkitRequire('../package.json').version, '3.3.9');
  assert.throws(() => adbkitRequire.resolve('node-forge'), { code: 'MODULE_NOT_FOUND' });
  const client = adb.createClient({ host: '127.0.0.1', port: 5037 });
  assert.equal(typeof client.listDevices, 'function');
  assert.equal(typeof client.getDevice('test-device').install, 'function');
  assert.equal(typeof client.getDevice('test-device').shell, 'function');
});

for (const f of fixtures) {
  const exponent = Buffer.from(f.jwk.e, 'base64url').readUIntBE(0, Buffer.from(f.jwk.e, 'base64url').length);

  test(`RSA exponent ${exponent}: Android key metadata and native key exports`, async () => {
    const key = await adb.util.parsePublicKey(Buffer.from(`${f.androidKey}\n`));
    assert.ok(key instanceof KeyObject);
    assert.equal(key.comment, 'test@tailchrome');
    assert.equal(key.fingerprint, createHash('md5').update(f.struct).digest('hex').match(/../g).join(':'));
    assert.deepEqual(key.export({ format: 'jwk' }), f.jwk);
    const pem = key.export({ format: 'pem', type: 'spki' });
    assert.deepEqual(createPublicKey(pem).export({ format: 'jwk' }), f.jwk);
    const noComment = await adb.util.parsePublicKey(`${f.struct.toString('base64')}\0`);
    assert.equal(noComment.comment, '');
    assert.equal(noComment.fingerprint, key.fingerprint);
  });

  test(`RSA exponent ${exponent}: verifies the prehashed ADB token without double hashing`, async () => {
    const key = await adb.util.parsePublicKey(f.androidKey);
    assert.equal(key.verify(f.token, f.signature), true);
    assert.equal(key.verify(f.token.toString('binary'), f.signature.toString('binary')), true);
    assert.equal(key.verify(f.token, sign('sha1', f.token, f.privateKey)), false);
    const withoutNull = Buffer.concat([Buffer.from('301f300706052b0e03021a0414', 'hex'), f.token]);
    assert.equal(key.verify(f.token, signPayload(f.privateKey, withoutNull)), true);
  });

  test(`RSA exponent ${exponent}: rejects forged DigestInfo, padding, and altered signatures`, async () => {
    const key = await adb.util.parsePublicKey(f.androidKey);
    // GHSA-86w9-cpqp-85rv: forge accepts an extra nested AlgorithmIdentifier
    // value. With exponent 3 this parser weakness enables signature forgery.
    const nestedGarbage = Buffer.concat([
      Buffer.from('3024300c06052b0e03021a05000401ff0414', 'hex'),
      f.token,
    ]);
    const validPayload = Buffer.concat([sha1Prefix, f.token]);
    const wrongAlgorithm = Buffer.from(validPayload);
    wrongAlgorithm[10] ^= 1;
    for (const payload of [nestedGarbage, wrongAlgorithm, Buffer.concat([validPayload, Buffer.from([0])])]) {
      assert.equal(key.verify(f.token, signPayload(f.privateKey, payload)), false);
    }
    const badPadding = Buffer.alloc(f.signature.length, 0xff);
    badPadding[0] = 0;
    badPadding[1] = 2; // RSA signature padding requires block type 1.
    badPadding[badPadding.length - validPayload.length - 1] = 0;
    validPayload.copy(badPadding, badPadding.length - validPayload.length);
    const badPaddingSignature = privateEncrypt({ key: f.privateKey, padding: constants.RSA_NO_PADDING }, badPadding);
    assert.equal(key.verify(f.token, badPaddingSignature), false);
    const changedToken = Buffer.from(f.token);
    changedToken[0] ^= 1;
    const changedSignature = Buffer.from(f.signature);
    changedSignature[0] ^= 1;
    assert.equal(key.verify(changedToken, f.signature), false);
    assert.equal(key.verify(f.token, changedSignature), false);
    assert.equal(key.verify(f.token.subarray(1), f.signature), false);
    assert.equal(key.verify(f.token, f.signature.subarray(1)), false);
    assert.equal(key.verify(f.token, Buffer.alloc(f.signature.length, 0xff)), false);
    assert.equal(key.verify(f.token, Buffer.alloc(0)), false);
  });

  test(`RSA exponent ${exponent}: CLI preserves PEM, OpenSSH, and fingerprint commands`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'tailchrome-adbkit-'));
    try {
      const keyPath = join(dir, 'adbkey.pub');
      writeFileSync(keyPath, `${f.androidKey}\n`);
      const cli = (...args) => execFileSync(process.execPath, [join(adbkitRoot, 'bin/adbkit'), ...args], { encoding: 'utf8' });
      const pem = cli('pubkey-convert', keyPath, '--format', 'pem');
      assert.deepEqual(createPublicKey(pem).export({ format: 'jwk' }), f.jwk);
      assert.deepEqual(parseSsh(cli('pubkey-convert', keyPath, '--format', 'openssh')), f.jwk);
      const fingerprint = createHash('md5').update(f.struct).digest('hex').match(/../g).join(':');
      assert.equal(cli('pubkey-fingerprint', keyPath).trim(), `${fingerprint} test@tailchrome`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('rejects malformed Android key structures and unsupported exponents', async () => {
  const { struct } = fixtures[0];
  const badLength = Buffer.from(struct);
  badLength.writeUInt32LE(65);
  const badExponent = Buffer.from(struct);
  badExponent.writeUInt32LE(17, badExponent.length - 4);
  for (const malformed of [Buffer.alloc(0), Buffer.from([1]), struct.subarray(1), badLength, badExponent]) {
    await assert.rejects(adb.util.parsePublicKey(malformed.toString('base64')), /Invalid public key|Invalid exponent/);
  }
  await assert.rejects(adb.util.parsePublicKey('not a public key!'), /Unrecognizable public key format/);
});

test('ADB authentication accepts known keys and verifies new keys before requesting authorization', async () => {
  const f = fixtures[0];
  const key = await adb.util.parsePublicKey(f.androidKey);
  let accepted = 0;
  let requested = 0;
  const state = {
    token: f.token,
    options: { knownPublicKeys: [key] },
    _acceptConnection() { accepted++; },
    write() {},
    _skipNull: Socket.prototype._skipNull,
  };
  await Socket.prototype._handleAuthPacket.call(state, { arg0: 2, data: f.signature });
  assert.equal(accepted, 1);
  state.signature = undefined;
  state.options = {
    knownPublicKeys: [],
    async auth(receivedKey) {
      requested++;
      assert.ok(receivedKey instanceof KeyObject);
      assert.equal(receivedKey.fingerprint, key.fingerprint);
    },
  };
  await Socket.prototype._handleAuthPacket.call(state, { arg0: 2, data: f.signature });
  assert.equal(accepted, 1);
  await Socket.prototype._handleAuthPacket.call(state, { arg0: 3, data: Buffer.from(`${f.androidKey}\0`) });
  assert.equal(requested, 1);
  assert.equal(accepted, 2);
  state.signature = Buffer.alloc(f.signature.length);
  await assert.rejects(
    Socket.prototype._handleAuthPacket.call(state, { arg0: 3, data: Buffer.from(`${f.androidKey}\0`) }),
    /Signature mismatch/,
  );
  assert.equal(requested, 1);
  assert.equal(accepted, 2);
});
