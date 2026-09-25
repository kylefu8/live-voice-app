import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { encodeQr } from '../qr.mjs';
import { encryptConfig, decryptConfig, MAX_PAYLOAD_LENGTH } from '../crypto.mjs';

function pixels(qr) {
  const scale = 5;
  const size = (qr.getModuleCount() + 8) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let row = 0; row < qr.getModuleCount(); row++) {
    for (let col = 0; col < qr.getModuleCount(); col++) {
      if (!qr.isDark(row, col)) continue;
      for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
        const offset = (((row + 4) * scale + y) * size + (col + 4) * scale + x) * 4;
        data[offset] = data[offset + 1] = data[offset + 2] = 0;
      }
    }
  }
  return { data, size };
}
test('independent QR decoder recovers an encrypted two-connection configuration', async () => {
  const credential = { endpoint:'https://example.invalid/v1',model:'test-model',auth:'bearer',apiKey:'demo-not-real-key-1234' };
  const config = { version:1,connections:{voice:credential,backend:credential} };
  const encoded = await encryptConfig(config,'fictional roundtrip phrase');
  const {data,size} = pixels(encodeQr(encoded));
  const decoded = jsQR(data,size,size);
  assert.equal(decoded?.data,encoded);
  assert.deepEqual(await decryptConfig(decoded.data,'fictional roundtrip phrase'),config);
});
test('maximum supported payload fits a single medium-error-correction QR and decodes', () => {
  const payload = 'LV1.' + 'a'.repeat(MAX_PAYLOAD_LENGTH - 4);
  const qr = encodeQr(payload);
  assert.ok(qr.getModuleCount() <= 177);
  const {data,size} = pixels(qr);
  assert.equal(jsQR(data,size,size)?.data,payload);
  assert.throws(() => encodeQr(payload + 'a'),/payload_too_large/);
});
