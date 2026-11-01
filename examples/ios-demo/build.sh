#!/usr/bin/env bash
# Builds TapdanceDemo.app for the iOS Simulator without an Xcode project (swiftc + Info.plist).
set -euo pipefail
cd "$(dirname "$0")"
ARCH="$(uname -m)"; [ "$ARCH" = "arm64" ] || ARCH="x86_64"
OUT="build/TapdanceDemo.app"
rm -rf build && mkdir -p "$OUT"
xcrun -sdk iphonesimulator swiftc -parse-as-library -O \
  -target "${ARCH}-apple-ios17.0-simulator" DemoApp.swift -o "$OUT/TapdanceDemo"
cat > "$OUT/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.tapdance.demo</string>
  <key>CFBundleExecutable</key><string>TapdanceDemo</string>
  <key>CFBundleName</key><string>TapdanceDemo</string>
  <key>CFBundleDisplayName</key><string>Tapdance Demo</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>MinimumOSVersion</key><string>17.0</string>
  <key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>
  <key>UIDeviceFamily</key><array><integer>1</integer></array>
  <key>UILaunchScreen</key><dict/>
  <key>UIApplicationSceneManifest</key><dict><key>UIApplicationSupportsMultipleScenes</key><false/></dict>
</dict></plist>
PLIST
codesign --force --sign - "$OUT" >/dev/null
echo "$PWD/$OUT"
