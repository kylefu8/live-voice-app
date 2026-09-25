import assert from 'node:assert/strict';
import { createCipheriv, pbkdf2Sync, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

if (!globalThis.crypto?.subtle) {
  globalThis.crypto = webcrypto;
}

import {
  ConfigCryptoError,
  MAX_PAYLOAD_LENGTH,
  decryptConfig,
  encryptConfig,
  validateConfig,
} from '../crypto.mjs';

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/config.json', import.meta.url), 'utf8'),
);
const vector = JSON.parse(
  await readFile(new URL('./fixtures/fixed-vector.json', import.meta.url), 'utf8'),
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function assertCode(operation, expectedCode) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof ConfigCryptoError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message, expectedCode);
    return true;
  });
}

function independentlyComputeVector(config, passphrase, saltHex, nonceHex) {
  const salt = Buffer.from(saltHex, 'hex');
  const nonce = Buffer.from(nonceHex, 'hex');
  const saltPart = salt.toString('base64url');
  const noncePart = nonce.toString('base64url');
  const aad = Buffer.from(`LV1.600000.${saltPart}.${noncePart}`);
  const key = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, 600000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(config), 'utf8')),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `LV1.600000.${saltPart}.${noncePart}.${ciphertext.toString('base64url')}`;
}

test('validateConfig returns stable schema and removes endpoint trailing slashes', () => {
  const normalized = validateConfig(fixture);
  assert.deepEqual(normalized, {
    version: 1,
    connections: {
      voice: {
        endpoint: 'https://voice.example.test/v1',
        model: 'gpt-live-1',
        auth: 'bearer',
        apiKey: 'synthetic-voice-key-7f3a',
      },
      backend: {
        endpoint: 'https://backend.example.test/openai',
        model: 'reasoning-mini',
        auth: 'api-key',
        apiKey: 'synthetic-backend-key-9c2b',
      },
    },
  });
});

test('round trips Unicode config and preserves passphrase bytes exactly', async () => {
  const config = clone(fixture);
  config.connections.voice.model = 'gpt-live-1-练习✨';
  config.connections.voice.apiKey = 'synthetic-voice-密钥-7f3a';
  const passphrase = ' 口令前后空格 ✨ ';
  const payload = await encryptConfig(config, passphrase);

  assert.ok(payload.startsWith('LV1.600000.'));
  assert.ok(payload.length <= MAX_PAYLOAD_LENGTH);
  assert.deepEqual(await decryptConfig(payload, passphrase), validateConfig(config));
  await assertCode(() => decryptConfig(payload, passphrase.trim()), 'decrypt_failed');
});

test('each encryption uses a fresh salt and nonce', async () => {
  const first = await encryptConfig(fixture, 'randomization password');
  const second = await encryptConfig(fixture, 'randomization password');
  assert.notEqual(first, second);
  assert.ok(first.length <= MAX_PAYLOAD_LENGTH);
  assert.ok(second.length <= MAX_PAYLOAD_LENGTH);
});

test('wrong password and ciphertext bit flips fail without exposing details', async () => {
  const payload = await encryptConfig(fixture, 'correct password');
  await assertCode(() => decryptConfig(payload, 'wrong password'), 'decrypt_failed');

  const parts = payload.split('.');
  const firstCiphertextCharacter = parts[4][0];
  parts[4] = `${firstCiphertextCharacter === 'A' ? 'B' : 'A'}${parts[4].slice(1)}`;
  await assertCode(() => decryptConfig(parts.join('.'), 'correct password'), 'decrypt_failed');
});

test('authenticated metadata changes fail and unsupported versions are explicit', async () => {
  const payload = await encryptConfig(fixture, 'metadata password');
  const parts = payload.split('.');
  const firstNonceCharacter = parts[3][0];
  parts[3] = `${firstNonceCharacter === 'A' ? 'B' : 'A'}${parts[3].slice(1)}`;
  await assertCode(() => decryptConfig(parts.join('.'), 'metadata password'), 'decrypt_failed');
  await assertCode(() => decryptConfig(payload.replace(/^LV1/u, 'LV2'), 'metadata password'), 'unsupported_version');
});

test('fixed vector matches an independent Node crypto implementation', async () => {
  const normalized = validateConfig(fixture);
  const computed = independentlyComputeVector(
    normalized,
    vector.passphrase,
    vector.saltHex,
    vector.nonceHex,
  );
  assert.equal(computed, vector.payload);
  assert.deepEqual(await decryptConfig(vector.payload, vector.passphrase), normalized);
});

test('rejects unknown keys, insecure endpoints, controls, and masked keys', async () => {
  const unknown = clone(fixture);
  unknown.connections.extra = clone(unknown.connections.voice);
  await assertCode(() => encryptConfig(unknown, 'valid password'), 'invalid_config');

  const query = clone(fixture);
  query.connections.voice.endpoint = 'https://voice.example.test/v1?tenant=demo';
  await assertCode(() => encryptConfig(query, 'valid password'), 'invalid_endpoint');

  const insecure = clone(fixture);
  insecure.connections.voice.endpoint = 'http://voice.example.test/v1';
  await assertCode(() => encryptConfig(insecure, 'valid password'), 'invalid_endpoint');

  const controls = clone(fixture);
  controls.connections.voice.model = 'gpt-live-1\n';
  await assertCode(() => encryptConfig(controls, 'valid password'), 'invalid_model');

  const unpaired = clone(fixture);
  unpaired.connections.voice.model = `gpt-live-1${String.fromCharCode(0xd800)}`;
  await assertCode(() => encryptConfig(unpaired, 'valid password'), 'invalid_model');

  const masked = clone(fixture);
  masked.connections.voice.apiKey = 'sk-...1234';
  await assertCode(() => encryptConfig(masked, 'valid password'), 'invalid_key');
});

test('enforces passphrase, field, and complete payload size limits', async () => {
  await assertCode(() => encryptConfig(fixture, 'abc'), 'invalid_passphrase');
  const fourCharacterPayload = await encryptConfig(fixture, 'a1b2');
  assert.deepEqual(await decryptConfig(fourCharacterPayload, 'a1b2'), validateConfig(fixture));
  const legacyPayload = independentlyComputeVector(validateConfig(fixture), 'abc', vector.saltHex, vector.nonceHex);
  assert.deepEqual(await decryptConfig(legacyPayload, 'abc'), validateConfig(fixture));
  await assertCode(() => encryptConfig(fixture, ''), 'invalid_passphrase');
  await assertCode(() => encryptConfig(fixture, ' '.repeat(4)), 'invalid_passphrase');
  await assertCode(() => encryptConfig(fixture, 'p'.repeat(257)), 'invalid_passphrase');

  const tooLongKey = clone(fixture);
  tooLongKey.connections.voice.apiKey = 'k'.repeat(4097);
  await assertCode(() => encryptConfig(tooLongKey, 'valid password'), 'invalid_key');

  const tooLongModel = clone(fixture);
  tooLongModel.connections.voice.model = 'm'.repeat(257);
  await assertCode(() => encryptConfig(tooLongModel, 'valid password'), 'invalid_model');

  const tooLarge = clone(fixture);
  tooLarge.connections.voice.apiKey = 'k'.repeat(2000);
  await assertCode(() => encryptConfig(tooLarge, 'valid password'), 'payload_too_large');

  await assertCode(() => decryptConfig('x'.repeat(MAX_PAYLOAD_LENGTH + 1), 'valid password'), 'payload_too_large');
});

test('requires at least one complete supported connection', async () => {
  const noConnections = { version: 1, connections: {} };
  await assertCode(() => encryptConfig(noConnections, 'valid password'), 'invalid_config');

  const missing = clone(fixture);
  delete missing.connections.voice.apiKey;
  await assertCode(() => encryptConfig(missing, 'valid password'), 'invalid_config');

  const wrongVersion = clone(fixture);
  wrongVersion.version = 2;
  await assertCode(() => encryptConfig(wrongVersion, 'valid password'), 'unsupported_version');
});
