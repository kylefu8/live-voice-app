# Standalone connection QR tool

[简体中文](README.md) | **English**

This optional local web tool generates encrypted connection QR codes for the **Live Voice GPT-Live-1 client**. For normal use, the [Windows app](../desktop/README.en.md) integrates model configuration, tests, conversations, and QR export in one place.

## Run locally

With the Node version required by `package.json`, run `npm ci --ignore-scripts` and `node server.mjs` inside `pc-config/`, then open `http://127.0.0.1:8792/`. Use a current browser; do not open the HTML directly. Stop the server with Ctrl+C.

Enter voice and optional backend endpoints, deployment names, authentication methods, and keys. Each connection can be tested independently. Tests make real requests through the loopback service only after an explicit click, may incur provider usage, and do not automatically save or export configuration.

Select the connections to export, enter and confirm a passphrase of at least four characters, then generate the QR code. Encryption runs in the browser using authenticated encryption and a passphrase-derived key. The passphrase is not part of the QR payload. The QR library is bundled locally.

On mobile, open **Settings → Connections → Import connections from QR**, enter the same passphrase, review the masked configuration, then test/save. Import transfers connections only; enable the mobile backend preference separately. See the [complete guide](../docs/GETTING_STARTED.en.md).

Both Chinese and English and light/dark/system appearance are supported. Local cryptographic tests do not establish physical camera quality, phone connectivity, or model behavior. Do not commit real credentials or generated real-configuration QR images.
