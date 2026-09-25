# iOS installation and development

[简体中文](IOS.md) | **English**

Live Voice is a real-time voice client for **GPT-Live-1**. [Getting started](../docs/GETTING_STARTED.en.md) · [Downloads](../docs/DOWNLOADS.en.md) · [Screenshots](../docs/SCREENSHOTS.en.md)

## Installation on your own device

The project does not currently provide App Store or TestFlight distribution. Use a Mac with Xcode and a supported iOS device:

1. Install/update Xcode and sign in under **Xcode → Settings → Accounts** with your Apple ID.
2. Connect the device, unlock it, trust the computer, and enable Developer Mode if requested by iOS.
3. Open `native/ios/LiveVoiceApp.xcworkspace`. Under the app target's **Signing & Capabilities**, enable **Automatically manage signing** and choose your team. Keep the app and Live Activity extension on the same team.
4. Select the connected device and build/run. Complete any signing or keychain prompts locally; do not share passwords or verification codes.
5. If iOS reports an untrusted developer, approve your own development identity through the device's system management settings, then reopen the app.

A regular Apple ID's Personal Team can be used for testing on your own devices, subject to Apple's signing validity and capability limits. App Store or TestFlight distribution requires the appropriate developer program. Personal provisioning artifacts remain local and are not general-purpose download packages.

## Build setup

Use the Node/Ruby versions required by the repository's build scripts and dependencies. From `native/`, run `npm ci` and then `bash scripts/build-ios.sh simulator` on macOS. The helper installs/checks Ruby dependencies, configures the Live Activity extension, runs CocoaPods, and builds a Release simulator bundle.

For manual Xcode development, open the workspace, not the `.xcodeproj`. Re-run CocoaPods after dependency/project changes. The JS bundle is embedded; installed Release apps do not require Metro or the PC web tool.

For device command-line builds, configure the local `DEVELOPMENT_TEAM` and use `bash scripts/build-ios.sh device`; signing still depends on Xcode/account/keychain setup. Keep signing identities and device identifiers out of committed files and logs shared publicly.

The UI version comes from `package.json`. Small fixes use a suffix such as `0.5.0-1`; Apple's marketing version remains three-part (`0.5.0`) while its build number increases. Main app and extension versions must match.

## Platform behavior

- Camera QR import, local decryption, masked review, and test-before-save.
- Keychain storage, independent local text history, recording, and playback.
- Foreground keep-awake; connected sessions can continue audio in the background with local Live Activity updates. Audio interruptions or process termination are not automatic reconnection.
- Left-edge back navigation, transcript follow/unfollow behavior, and supported live preference updates.
- Non-live settings are disabled during a call. Tone and intonation are model preferences; provider acknowledgments do not establish every audible effect.

## Tests and release checks

Simulator test harnesses use synthetic state and are only for isolated UI, protocol, recording-encoding, or bridge checks. `DocsHarness.tsx` generates documentation screenshots without contacting model services. Restore the normal entry point after tests; production bundles must not contain a harness or demonstration credentials.

Verify actual camera scanning, microphone/speaker behavior, Bluetooth routing, interruption, background operation, and recordings separately on physical devices. Keep local diagnostics, personal device details, endpoints, keys, and conversations out of the repository and documentation screenshots.
