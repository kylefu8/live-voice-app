#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [ "$(uname -s)" != Darwin ]; then
  echo 'iOS builds require macOS and Xcode.' >&2
  exit 1
fi
# These versioned tools do not replace the shell's system Node/Ruby settings.
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/opt/ruby@3.4/bin:$PATH"
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
command -v node >/dev/null
xcodebuild -version
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
bundle config set --local path ../work/ruby-gems
if ! bundle check >/dev/null; then
  SDKROOT="$(xcrun --sdk macosx --show-sdk-path)" bundle install
fi
bundle exec ruby scripts/setup-ios-live-activity.rb
cd ios
bundle exec pod install
version="$(node -p 'require("../package.json").version.split("-")[0]')"
if [ "${1:-simulator}" = simulator ]; then
  xcodebuild -workspace LiveVoiceApp.xcworkspace -scheme LiveVoiceApp \
    -configuration Release -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath ../../work/ios-build \
    MARKETING_VERSION="$version" CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-
elif [ "${1:-}" = device ]; then
  # Xcode must already be signed in by the user. Team identifiers remain local.
  : "${DEVELOPMENT_TEAM:?Set DEVELOPMENT_TEAM to your Xcode Personal Team ID}"
  xcodebuild -workspace LiveVoiceApp.xcworkspace -scheme LiveVoiceApp \
    -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
    -derivedDataPath ../../work/ios-device-build \
    MARKETING_VERSION="$version" DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
    CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates
else
  echo 'Usage: bash scripts/build-ios.sh [simulator|device]' >&2
  exit 1
fi
