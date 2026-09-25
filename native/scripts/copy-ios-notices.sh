#!/bin/sh
set -eu
task_repo="$(cd "$SRCROOT/../.." && pwd)"
task_dest="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"
mkdir -p "$task_dest/third-party"
cp -R "$task_repo/third-party/." "$task_dest/third-party/"
cp "$task_repo/LICENSE" "$task_dest/Live-Voice-LICENSE.txt"
# CocoaPods generates acknowledgements from the exact installed pod versions.
task_pods="$PODS_ROOT/Target Support Files/Pods-LiveVoiceApp/Pods-LiveVoiceApp-acknowledgements.markdown"
if [ ! -f "$task_pods" ]; then
  echo 'Missing CocoaPods acknowledgements. Run pod install before building.' >&2
  exit 1
fi
cp "$task_pods" "$task_dest/third-party/iOS-Pods-Acknowledgements.md"
