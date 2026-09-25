# Live Voice Windows

[简体中文](README.md) | **English**

A Windows client for the **GPT-Live-1 real-time voice model**. Current revision: **0.2.0-2**. [Downloads](../docs/DOWNLOADS.en.md) · [Getting started](../docs/GETTING_STARTED.en.md) · [Screenshots](../docs/SCREENSHOTS.en.md)

## Install and start

Download the x64 ZIP from the [unified release page](https://github.com/kylefu8/live-voice-app/releases/latest), extract the complete folder, and run `Live Voice.exe`. Keep all accompanying files. No separate Node.js installation is needed. The portable package is currently unsigned and has no automatic updater or Microsoft Store distribution.

End any active conversation and exit the old app before launching an updated folder. The application retains its existing system-encrypted credential store and local history directory.

## Connect GPT-Live-1 and a backend

Open **Settings → Connections** and configure voice and backend endpoints, deployment/model identifiers, authentication methods, and keys separately. Save and test each connection. Official Azure OpenAI resource roots normalize to `/openai/v1`; existing complete paths are kept, and custom gateway prefixes are not guessed.

Enable a backend LLM in **Conversation settings** for reasoning and search. Defaults for new settings include 32768 maximum output tokens and web search enabled. Existing saved preferences are preserved. Capability depends on the configured provider; tests and conversations can incur service usage.

Windows connects directly to services and does not act as a phone relay. The microphone is used when the user starts a conversation or a microphone test.

## Settings and conversation

- Separate pages for conversation settings, connections, audio devices, appearance/language, and About.
- Chinese/English and light/dark/system themes. About displays the package version, author, and repository.
- Choose and locally test input/output devices. Explicit unavailable device choices do not silently fall back.
- Save supported style, instruction, and duration changes during a call. Backend changes affect subsequent requests; an in-flight request retains its snapshot.
- Voice identity, devices, and connection editing/testing are disabled during a call. Updating a duration to less than elapsed time is rejected rather than immediately ending the call.
- Captions remain visible; only search sources collapse. Backend progress is local request status and elapsed time, not access to the model's internal thinking.
- History can be renamed or deleted, with optional backend-generated titles. Windows currently stores text history, not mobile-style two-sided recordings.

## Link a phone

In **Connections → Generate configuration QR**, choose saved connections and enter/confirm a passphrase of at least four characters. The encrypted QR contains connection configuration, never the passphrase or conversation history. Scan it on mobile, enter the same passphrase, review, and test/save. The phone must separately enable its backend preference.

Leaving this page clears the in-memory export passphrase and current QR. Changing the passphrase does not revoke previously saved codes; credential access is revoked at the provider.

## Development

Run `npm ci`, `npm test`, and `npm run build` inside `desktop/` with the Node version required by `package.json`. On the configured Windows development machine, `build.ps1 -Package` builds and packages into versioned directories under `../releases/windows/`.

The renderer is sandboxed. Credentials remain in the main process using `safeStorage`; the renderer receives masked connection summaries only. See the English [contract](CONTRACT.md) for IPC, persistence, session cancellation, and validation details. Unit/UI tests do not replace real microphone, service, or audio-routing checks.
