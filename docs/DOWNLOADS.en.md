# Downloads and installation

[简体中文](DOWNLOADS.md) | **English**

Live Voice is a **GPT-Live-1 real-time voice client**, with an optional backend LLM. The **[latest unified release](https://github.com/kylefu8/live-voice-app/releases/latest)** provides both Windows and Android downloads. iOS is signed and installed using Xcode.

| Platform | File / method | Version |
| --- | --- | --- |
| Windows x64 | `live-voice-windows-0.2.0-2-x64.zip` | 0.2.0-2 |
| Android arm64 | `live-voice-android-0.5.0-2-arm64-v8a.apk` | 0.5.0-2 |
| iOS | Build and sign from source using a Mac and Xcode | 0.5.0-2 |

## Installation

- **Windows:** extract the whole ZIP and run `Live Voice.exe`. Do not move the EXE alone. End conversations and exit the old app before starting the new folder's executable. Existing user data stays in the same directory.
- **Android:** new users can install the APK normally. Internal test builds use a different signer and cannot update directly. Read the [signing transition](SIGNING-TRANSITION.en.md); do not uninstall or clear data.
- **iOS:** there is currently no App Store/TestFlight download. Follow the [iOS installation guide](../native/IOS.en.md) for signing and device installation. Personal signing artifacts are not published as a general-purpose IPA.

Android uses a separate release signing key. The Windows portable package currently has no code signature. Handle operating-system installation prompts through the normal device-owner flow.

## Verification and licensing

`SHA256SUMS.txt` in the release lists the APK and ZIP SHA-256 hashes. On Windows, use `Get-FileHash -Algorithm SHA256 <path>` and compare the result.

Current source uses the [noncommercial license](../LICENSE): all commercial uses require prior written authorization. Dependencies retain their own terms; see [commercial licensing](../COMMERCIAL-LICENSING.en.md).

[Start configuring](GETTING_STARTED.en.md) · [Screenshots](SCREENSHOTS.en.md)
