# Live Voice — Android / iOS client

[简体中文](README.md) | **English**

A mobile client for the **GPT-Live-1 real-time voice model**. Current revision: **0.5.0-2**. [Downloads](../docs/DOWNLOADS.en.md) · [Getting started](../docs/GETTING_STARTED.en.md) · [Screenshots](../docs/SCREENSHOTS.en.md)

## Using the app

Configure GPT-Live-1 and the optional backend LLM separately under **Settings → Connections**, or import an encrypted QR code from Windows. The phone connects directly to model services; the PC is not a relay. After import, enable the backend separately if required.

**Conversation settings** contains voice, tone, intonation, pace, instructions, total session duration, recording, and backend preferences. Supported changes save/apply automatically; text and output-length edits wait about 500 ms after typing stops. Returning or backgrounding flushes the last edit. An unconfirmed update shows an error with retry instead of claiming success.

Voice identity, voice connection, recording changes, and QR import cannot change during a call. Supported backend preferences affect the next request, preserving requests already in flight. Tone and pace are model preferences, not guarantees about acoustic output.

## Interface and local data

- Chinese and English, light/dark/system appearance, and adaptive balanced settings descriptions.
- Live captions follow the bottom by default; scrolling upward pauses following, and returning to the bottom resumes it. Only search sources collapse, not the transcript.
- In-call controls provide conversation settings, mute, and end. Foreground conversations keep the screen awake without changing system timeout preferences.
- Optional automatic recording of both sides, stored locally with history and retained until deleted. Recording failures do not imply that text history or the live conversation must stop.
- Rename history, delete only audio, or confirm deletion of both text and audio. A configured backend can generate titles from short excerpts.
- API keys use system secure storage and are only displayed as masked prefixes/suffixes. QR codes do not transfer history, recordings, or preferences.
- iOS supports left-edge back navigation, background audio, and local Live Activity status. Android uses system back and communication-device routing. Physical audio routing and provider behavior must be tested on the target environment.

## Building Android

Use Node.js compatible with `package.json`, an Android SDK/JDK, and the project build setup. From `native/`, run `npm ci`, `npm run typecheck`, and `npm test -- --runInBand`. The Windows helper `scripts/build-android.ps1` uses the locally configured toolchain and writes the APK to `../releases/android/<version>/`.

Install as an in-place update after ending an active conversation; do not clear app data. Follow device installation prompts normally. The app is named Live Voice.

## Building iOS

See [iOS installation and development](IOS.en.md). It uses the shared React Native UI with native camera, secure storage, audio, recording, and Live Activity bridges. Signing and physical-device verification are separate from simulator tests.

## Validation boundaries

Unit tests, cryptographic vectors, mocked sessions, UI screenshots, real-provider tests, and physical audio tests are different evidence. Documentation screenshots use synthetic data. Model probes use real network calls only when explicitly requested from the app and may incur usage.

The source layout includes `App.tsx` (UI), `src/live.ts` (voice session), `src/backend.ts` (Responses), `src/protocol.ts` (validation/instructions), `src/storage.ts` (local settings and history), and native platform bridges. See the [protocol design](../design/native-protocol.md) and platform source for developer detail.
