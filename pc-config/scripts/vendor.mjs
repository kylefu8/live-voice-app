import { copyFile, mkdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
await mkdir(new URL('vendor/', root), { recursive: true });
await copyFile(new URL('node_modules/qrcode-generator/dist/qrcode.mjs', root), new URL('vendor/qrcode.mjs', root));
await copyFile(new URL('node_modules/qrcode-generator/README.md', root), new URL('vendor/qrcode.README.md', root));
// The package declares MIT but does not ship a license file. Keep the complete
// license checked in alongside the original source copyright header.
await import('node:fs/promises').then(({access})=>access(new URL('vendor/qrcode.LICENSE.txt',root)));
await copyFile(new URL('../design/logo-v1-icon.png', root), new URL('logo.png', root));
console.log('Local QR encoder, license and logo copied.');
