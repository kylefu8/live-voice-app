import qrcode from './vendor/qrcode.mjs';
import { MAX_PAYLOAD_LENGTH } from './crypto.mjs';

export function encodeQr(payload) {
  if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD_LENGTH || !/^[\x20-\x7e]+$/.test(payload)) {
    throw new Error('payload_too_large');
  }
  const qr = qrcode(0, 'M');
  qr.addData(payload, 'Byte');
  qr.make();
  return qr;
}

export function drawQr(canvas, payload) {
  const qr = encodeQr(payload);
  const count = qr.getModuleCount();
  const cell = Math.max(4, Math.floor(1024 / (count + 8)));
  canvas.width = canvas.height = (count + 8) * cell;
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000000';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) context.fillRect((col + 4) * cell, (row + 4) * cell, cell, cell);
    }
  }
}
