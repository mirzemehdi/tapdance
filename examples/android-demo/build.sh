#!/usr/bin/env bash
# Builds TapdanceDemo.apk (debug-signed) with the Android SDK's own tools: no Gradle, no resources.
# With --aab it also builds TapdanceDemo.aab (an Android App Bundle) with bundletool, found through
# $BUNDLETOOL (a .jar) or ~/.tapdance/tools/bundletool/*.jar.
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
BT="$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)"
PLATFORM="$(ls -d "$SDK"/platforms/android-3[4-9]* 2>/dev/null | sort -V | head -1)"
[ -n "$PLATFORM" ] || { echo "Need an Android platform 34+ in $SDK/platforms" >&2; exit 1; }
rm -rf build && mkdir -p build/classes build/dex
"$BT/aapt2" link -o build/unsigned.apk --manifest AndroidManifest.xml -I "$PLATFORM/android.jar"
javac -source 11 -target 11 -classpath "$PLATFORM/android.jar" -d build/classes $(find src -name '*.java') 2>&1 | grep -v "^warning\|^Note" || true
"$BT/d8" --min-api 26 --lib "$PLATFORM/android.jar" --output build/dex $(find build/classes -name '*.class')
( cd build/dex && zip -q ../unsigned.apk classes.dex )
"$BT/zipalign" -f 4 build/unsigned.apk build/aligned.apk
KEY="build/debug.keystore"
keytool -genkeypair -keystore "$KEY" -storepass android -keypass android -alias demo -keyalg RSA -keysize 2048 \
  -validity 10000 -dname "CN=Tapdance Demo" >/dev/null 2>&1
"$BT/apksigner" sign --ks "$KEY" --ks-pass pass:android --out build/TapdanceDemo.apk build/aligned.apk
echo "$PWD/build/TapdanceDemo.apk"

if [ "${1:-}" = "--aab" ]; then
  JAR="${BUNDLETOOL:-$(ls "$HOME"/.tapdance/tools/bundletool/bundletool-all-*.jar 2>/dev/null | sort -V | tail -1)}"
  [ -n "$JAR" ] || { echo "Need bundletool: set BUNDLETOOL to its .jar" >&2; exit 1; }
  JAVA="${JAVA_HOME:+$JAVA_HOME/bin/}java"
  # A bundle module holds the manifest and resources in protobuf form, plus the dex.
  "$BT/aapt2" link --proto-format --version-code 1 --version-name 1.0 -o build/proto.zip --manifest AndroidManifest.xml -I "$PLATFORM/android.jar"
  rm -rf build/module && mkdir -p build/module/manifest build/module/dex
  ( cd build/module && unzip -q ../proto.zip && mv AndroidManifest.xml manifest/ )
  cp build/dex/classes.dex build/module/dex/
  ( cd build/module && zip -q -r ../base.zip . )
  rm -f build/TapdanceDemo.aab
  "$JAVA" -jar "$JAR" build-bundle --modules=build/base.zip --output=build/TapdanceDemo.aab
  echo "$PWD/build/TapdanceDemo.aab"
fi
