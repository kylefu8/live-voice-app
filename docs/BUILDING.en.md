# Build and release

[简体中文](BUILDING.md) | **English**

## Android

1. Install Android Studio with its JDK, Android SDK, and the SDK/NDK versions declared by Gradle.
2. Install Node 24. The Windows build script uses project-local
   `work/toolchain/node-v24.21.0-win-x64/node.exe` and
   `work/toolchain/ninja/ninja.exe`. Obtain official distributions from
   [Node.js](https://nodejs.org/) and [Ninja](https://github.com/ninja-build/ninja/releases).
3. Run `npm ci` in `native/`. Debug builds use the Android SDK's locally generated debug key.
4. Release builds require your own signing key. Follow the [Android signing guide](https://developer.android.com/studio/publish/app-signing),
   back up the key securely, and provide `LIVEVOICE_KEYSTORE_PATH`,
   `LIVEVOICE_KEYSTORE_PASSWORD`, `LIVEVOICE_KEY_ALIAS`, and `LIVEVOICE_KEY_PASSWORD`
   to the build process. Supply passwords through a local secret manager or non-echoing input;
   never store them in command history, source files, or logs.
5. Run `powershell -File scripts/build-android.ps1` from `native/`.
   Missing release signing causes a build failure; it never falls back to debug signing.

Release resources default to `127.0.0.1` for the React Native dev server so they do not
contain the build host's LAN address. Override `-PreactNativeDevServerIp=...` only for
local development, never for public distribution. No signing key is included in the
public source. Your own key cannot update an installation signed by the official publisher.
See the [signing transition](SIGNING-TRANSITION.en.md) for older test installations.

## Windows

With Node 24, run `npm ci`, `npm test`, and `npm run build` in `desktop/`.
`npm run package` uses the official Electron ZIP cached under
`work/toolchain/electron-<version>/`; see `desktop/package.json` for its version.
The portable build remains unsigned, as disclosed on the download page.

Packaging starts with a fresh staging directory. Launch a copy for smoke testing,
then archive the untouched distribution directory so runtime logs cannot enter the ZIP.
Retain Electron's bundled licenses.

## iOS

See [iOS build instructions](../native/IOS.en.md). The Xcode build phase copies third-party
notices and CocoaPods acknowledgements for the installed dependencies. Run `pod install`
first. Never distribute personal signing profiles or certificates.

## Release checks

- Check source, Git history, and tags for credentials, private addresses, device details, recordings, and conversations.
- Review and update [third-party notices](../third-party/README.md) when dependencies change.
- Verify APK signer/resources and ZIP contents; exclude private IPs, runtime logs, signing keys, and test entry points.
- Verify SHA-256 and provide Windows/Android downloads, the project license, and dependency notices together.
- Validate real-device audio and model behavior separately; compilation does not establish either.
