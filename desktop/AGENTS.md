# Live Voice Windows

- Follow ../AGENTS.md and CONTRACT.md. This is an Electron desktop client, separate from Android and the PC configuration web tool.
- Keep keys in main-process safeStorage encryption; never return plaintext keys over IPC, logs, renderer storage, screenshots, or errors.
- Bundle imported pure logic from ../pc-config and ../native/src; do not modify mobile/prototype code as an incidental desktop change.
- Device histories stay local. Phone linking exports only encrypted connection settings, never history or an embedded passphrase.
- Real voice/provider success requires credentials entered by the user and actual audio verification; unit tests, UI launch and packaging alone are insufficient.
