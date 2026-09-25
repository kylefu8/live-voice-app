const ENVELOPE_VERSION = 'LV1';
const PBKDF2_ITERATIONS = 600000;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

// The complete envelope is the value placed in one QR code.
export const MAX_PAYLOAD_LENGTH = 1800;

const ENVELOPE_FIXED_LENGTH =
  `${ENVELOPE_VERSION}.${PBKDF2_ITERATIONS}.`.length +
  22 + // base64url(16-byte salt), without padding
  1 +
  16 + // base64url(12-byte nonce), without padding
  1;
const TOP_LEVEL_KEYS = ['version', 'connections'];
const CONNECTION_KEYS = ['endpoint', 'model', 'auth', 'apiKey'];
const CONNECTION_NAMES = ['voice', 'backend'];
const AUTH_TYPES = new Set(['bearer', 'api-key']);

export class ConfigCryptoError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ConfigCryptoError';
    this.code = code;
  }
}

function fail(code) {
  throw new ConfigCryptoError(code);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactlyKeys(value, expectedKeys) {
  const actual = Reflect.ownKeys(value);
  return actual.length === expectedKeys.length && expectedKeys.every((key) => hasOwn(value, key));
}

function characterLength(value) {
  return Array.from(value).length;
}

function hasControlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
      } else {
        return true;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validateText(value, code, maximum) {
  if (typeof value !== 'string' || hasControlCharacters(value) || hasUnpairedSurrogate(value)) {
    fail(code);
  }
  const length = characterLength(value);
  if (length === 0 || value.trim().length === 0 || length > maximum) {
    fail(code);
  }
  return value;
}

function isClearlyMaskedKey(value) {
  // These are the forms used by the settings UI when a key is redacted. A
  // real key is never recovered by passing its masked display value back in.
  if (/[\u2026•·█＊*]/u.test(value) || /\.{3,}/u.test(value)) {
    return true;
  }
  if (/^(?:masked|redacted|hidden|removed|secret)$/iu.test(value)) {
    return true;
  }
  return value.length >= 4 && /^[xX*._\-•·…#]+$/u.test(value);
}

function normalizeEndpoint(value) {
  validateText(value, 'invalid_endpoint', 512);

  // URL() otherwise silently strips leading/trailing ASCII whitespace. Do
  // not turn an accidental paste into a different endpoint.
  if (value !== value.trim() || value.includes('?') || value.includes('#')) {
    fail('invalid_endpoint');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('invalid_endpoint');
  }

  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    fail('invalid_endpoint');
  }

  // URL serialisation gives one canonical authority spelling. The protocol
  // permits only trailing-slash normalisation; path/query semantics are not
  // changed.
  const normalized = parsed.toString().replace(/\/+$/u, '');
  if (!normalized || characterLength(normalized) > 512) {
    fail('invalid_endpoint');
  }
  return normalized;
}

function validateApiKey(value) {
  validateText(value, 'invalid_key', 4096);
  if (isClearlyMaskedKey(value)) {
    fail('invalid_key');
  }
  return value;
}

function validatePassphrase(passphrase, minimumLength = 1) {
  if (
    typeof passphrase !== 'string' ||
    hasControlCharacters(passphrase) ||
    hasUnpairedSurrogate(passphrase)
  ) {
    fail('invalid_passphrase');
  }
  const length = characterLength(passphrase);
  if (length < minimumLength || length > 256 || passphrase.trim().length === 0) {
    fail('invalid_passphrase');
  }
  // Deliberately return the original string. In particular, do not trim,
  // normalize Unicode, or otherwise change the PBKDF2 input.
  return passphrase;
}

/**
 * Validate and canonicalise the public configuration schema.
 *
 * The returned object has stable key order and endpoint trailing slashes
 * removed. It contains the API key because callers need it to encrypt; the
 * module never logs or persists it.
 */
export function validateConfig(config) {
  if (!isRecord(config) || !hasExactlyKeys(config, TOP_LEVEL_KEYS)) {
    fail('invalid_config');
  }
  if (config.version !== 1) {
    if (Number.isInteger(config.version)) {
      fail('unsupported_version');
    }
    fail('invalid_config');
  }
  if (!isRecord(config.connections)) {
    fail('invalid_config');
  }

  const connectionNames = Reflect.ownKeys(config.connections);
  if (
    connectionNames.length < 1 ||
    connectionNames.some((name) => !CONNECTION_NAMES.includes(name))
  ) {
    fail('invalid_config');
  }

  const connections = {};
  for (const name of CONNECTION_NAMES) {
    if (!hasOwn(config.connections, name)) {
      continue;
    }
    const connection = config.connections[name];
    if (!isRecord(connection) || !hasExactlyKeys(connection, CONNECTION_KEYS)) {
      fail('invalid_config');
    }
    const auth = connection.auth;
    if (typeof auth !== 'string' || !AUTH_TYPES.has(auth)) {
      fail('invalid_config');
    }
    connections[name] = {
      endpoint: normalizeEndpoint(connection.endpoint),
      model: validateText(connection.model, 'invalid_model', 256),
      auth,
      apiKey: validateApiKey(connection.apiKey),
    };
  }

  return { version: 1, connections };
}

function getWebCrypto() {
  const webCrypto = globalThis.crypto;
  if (!webCrypto || !webCrypto.subtle || typeof webCrypto.getRandomValues !== 'function') {
    fail('invalid_payload');
  }
  return webCrypto;
}

function encodeBase64Url(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  let base64;
  if (typeof globalThis.btoa === 'function') {
    base64 = globalThis.btoa(binary);
  } else if (typeof globalThis.Buffer === 'function') {
    base64 = globalThis.Buffer.from(bytes).toString('base64');
  } else {
    fail('invalid_payload');
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function decodeBase64Url(value, expectedLength) {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    fail('invalid_payload');
  }
  if (value.length % 4 === 1) {
    fail('invalid_payload');
  }

  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  let binary;
  try {
    if (typeof globalThis.atob === 'function') {
      binary = globalThis.atob(base64);
    } else if (typeof globalThis.Buffer === 'function') {
      const decoded = globalThis.Buffer.from(base64, 'base64');
      binary = String.fromCharCode(...decoded);
    } else {
      fail('invalid_payload');
    }
  } catch {
    fail('invalid_payload');
  }

  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value || (expectedLength !== undefined && bytes.length !== expectedLength)) {
    fail('invalid_payload');
  }
  return bytes;
}

function envelopeLengthForPlaintext(plaintextLength) {
  return ENVELOPE_FIXED_LENGTH + Math.ceil(((plaintextLength + TAG_BYTES) * 4) / 3);
}

function parseEnvelope(payload) {
  if (typeof payload !== 'string' || payload.length === 0) {
    fail('invalid_payload');
  }
  if (payload.length > MAX_PAYLOAD_LENGTH) {
    fail('payload_too_large');
  }
  if (/[^\x00-\x7f]/u.test(payload) || hasControlCharacters(payload)) {
    fail('invalid_payload');
  }

  const parts = payload.split('.');
  if (parts.length !== 5) {
    fail('invalid_payload');
  }
  const [version, kdf, saltPart, noncePart, ciphertextPart] = parts;

  if (version !== ENVELOPE_VERSION) {
    if (/^LV\d+$/u.test(version)) {
      fail('unsupported_version');
    }
    fail('invalid_payload');
  }
  if (kdf !== String(PBKDF2_ITERATIONS)) {
    if (/^\d+$/u.test(kdf)) {
      fail('unsupported_version');
    }
    fail('invalid_payload');
  }
  if (saltPart.length !== 22 || noncePart.length !== 16) {
    fail('invalid_payload');
  }

  const salt = decodeBase64Url(saltPart, SALT_BYTES);
  const nonce = decodeBase64Url(noncePart, NONCE_BYTES);
  const ciphertext = decodeBase64Url(ciphertextPart);
  if (ciphertext.length < TAG_BYTES) {
    fail('invalid_payload');
  }

  return {
    parts,
    salt,
    nonce,
    ciphertext,
    aad: new TextEncoder().encode(parts.slice(0, 4).join('.')),
  };
}

async function deriveAesKey(webCrypto, passphrase, salt, usage) {
  const passphraseBytes = new TextEncoder().encode(passphrase);
  const passwordKey = await webCrypto.subtle.importKey(
    'raw',
    passphraseBytes,
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const keyBits = await webCrypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    passwordKey,
    KEY_BYTES * 8,
  );
  return webCrypto.subtle.importKey('raw', keyBits, { name: 'AES-GCM' }, false, [usage]);
}

export async function encryptConfig(config, passphrase) {
  const normalized = validateConfig(config);
  const validatedPassphrase = validatePassphrase(passphrase, 4);
  const plaintext = new TextEncoder().encode(JSON.stringify(normalized));
  if (envelopeLengthForPlaintext(plaintext.length) > MAX_PAYLOAD_LENGTH) {
    fail('payload_too_large');
  }

  const webCrypto = getWebCrypto();
  const salt = new Uint8Array(SALT_BYTES);
  const nonce = new Uint8Array(NONCE_BYTES);
  webCrypto.getRandomValues(salt);
  webCrypto.getRandomValues(nonce);
  const saltPart = encodeBase64Url(salt);
  const noncePart = encodeBase64Url(nonce);
  const aad = new TextEncoder().encode(`${ENVELOPE_VERSION}.${PBKDF2_ITERATIONS}.${saltPart}.${noncePart}`);

  let encrypted;
  try {
    const key = await deriveAesKey(webCrypto, validatedPassphrase, salt, 'encrypt');
    encrypted = await webCrypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: TAG_BYTES * 8 },
      key,
      plaintext,
    );
  } catch {
    fail('invalid_payload');
  }

  const ciphertextPart = encodeBase64Url(new Uint8Array(encrypted));
  const payload = `${ENVELOPE_VERSION}.${PBKDF2_ITERATIONS}.${saltPart}.${noncePart}.${ciphertextPart}`;
  if (payload.length > MAX_PAYLOAD_LENGTH) {
    fail('payload_too_large');
  }
  return payload;
}

export async function decryptConfig(payload, passphrase) {
  const envelope = parseEnvelope(payload);
  const validatedPassphrase = validatePassphrase(passphrase);
  const webCrypto = getWebCrypto();

  let plaintext;
  try {
    const key = await deriveAesKey(webCrypto, validatedPassphrase, envelope.salt, 'decrypt');
    plaintext = await webCrypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: envelope.nonce,
        additionalData: envelope.aad,
        tagLength: TAG_BYTES * 8,
      },
      key,
      envelope.ciphertext,
    );
  } catch {
    fail('decrypt_failed');
  }

  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(plaintext));
  } catch {
    fail('decrypt_failed');
  }

  let config;
  try {
    config = JSON.parse(decoded);
  } catch {
    fail('decrypt_failed');
  }
  return validateConfig(config);
}
