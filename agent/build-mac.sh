#!/bin/sh
# Builds ../downloads/CompanyFiles.dmg on a Mac: one universal app for Intel and Apple Silicon.
# Used by .github/workflows/agent.yml; also runs on any Mac with Go and the Xcode command line tools.
#
# Signs and notarizes only when these are set (GitHub repository secrets); otherwise the app is ad-hoc signed and
# macOS asks once before opening it (right-click → Open, or System Settings → Privacy & Security → Open Anyway):
#   MACOS_CERT_P12        base64 of a "Developer ID Application" certificate exported as .p12
#   MACOS_CERT_PASSWORD   its password
#   APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD   for notarization (APPLE_APP_PASSWORD is an app-specific password)
set -eu
cd "$(dirname "$0")"
SERVER="${SERVER:-https://files.tail81e59e.ts.net}"
VERSION=$(sed -n 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' main.go | head -n 1)
TMP=build/mac
APP="$TMP/Company Files.app"
DMG=../downloads/CompanyFiles.dmg
rm -rf "$TMP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" ../downloads

go test ./...
go run ./tools/pack icons build
iconutil -c icns build/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"
# Runs on macOS 12 Monterey and every later version (the oldest the current Go supports). Without this the C and
# Objective-C parts would be built for the build machine's own macOS, and older Macs would refuse to start the app.
export MACOSX_DEPLOYMENT_TARGET=12.0
export CGO_CFLAGS="-mmacosx-version-min=12.0" CGO_LDFLAGS="-mmacosx-version-min=12.0"
for arch in arm64 amd64; do
  CGO_ENABLED=1 GOOS=darwin GOARCH=$arch go build -trimpath \
    -ldflags "-s -w -X main.version=$VERSION -X main.defaultServer=$SERVER" -o "$TMP/agent-$arch" .
  minos=$(vtool -show-build "$TMP/agent-$arch" | awk '/minos/ {print $2; exit}')
  echo "$arch: runs on macOS $minos and later"
  [ "$minos" = "12.0" ] || { echo "expected macOS 12.0 as the minimum, got $minos" >&2; exit 1; }
done
lipo -create -output "$APP/Contents/MacOS/CompanyFiles" "$TMP/agent-arm64" "$TMP/agent-amd64"

# LSUIElement: a tray (menu bar) app with no Dock icon. CFBundleURLTypes: macOS opens myfiles:// links with it.
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Company Files</string>
  <key>CFBundleDisplayName</key><string>Company Files</string>
  <key>CFBundleIdentifier</key><string>com.companyfiles.agent</string>
  <key>CFBundleExecutable</key><string>CompanyFiles</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleURLTypes</key>
  <array><dict>
    <key>CFBundleURLName</key><string>com.companyfiles.agent.link</string>
    <key>CFBundleURLSchemes</key><array><string>myfiles</string></array>
  </dict></array>
</dict>
</plist>
EOF

IDENTITY=""
if [ -n "${MACOS_CERT_P12:-}" ] && [ -n "${MACOS_CERT_PASSWORD:-}" ]; then
  KC="$PWD/$TMP/build.keychain-db"
  KCPW=$(openssl rand -hex 16)
  security create-keychain -p "$KCPW" "$KC"
  security set-keychain-settings -lut 3600 "$KC"
  security unlock-keychain -p "$KCPW" "$KC"
  printf '%s' "$MACOS_CERT_P12" | base64 --decode > "$TMP/cert.p12"
  security import "$TMP/cert.p12" -k "$KC" -P "$MACOS_CERT_PASSWORD" -T /usr/bin/codesign
  rm -f "$TMP/cert.p12"
  security set-key-partition-list -S apple-tool:,apple: -s -k "$KCPW" "$KC" >/dev/null
  security list-keychains -d user -s "$KC" $(security list-keychains -d user | tr -d '"')
  IDENTITY=$(security find-identity -v -p codesigning "$KC" | sed -n 's/.*"\(Developer ID Application[^"]*\)".*/\1/p' | head -n 1)
fi
if [ -n "$IDENTITY" ]; then
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
  echo "app signed: $IDENTITY"
else
  codesign --force --sign - "$APP" # ad-hoc: Apple Silicon needs at least this to run the app
  echo "app not signed with a Developer ID (no MACOS_CERT_P12 secret): ad-hoc signature only"
fi

STAGE="$TMP/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Company Files" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG"

if [ -n "$IDENTITY" ]; then
  codesign --timestamp --sign "$IDENTITY" "$DMG"
  if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
    xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait
    xcrun stapler staple "$DMG"
    echo "dmg notarized"
  else
    echo "dmg signed, not notarized (no APPLE_ID / APPLE_TEAM_ID / APPLE_APP_PASSWORD secrets)"
  fi
  security delete-keychain "$KC" || true
fi
lipo -archs "$APP/Contents/MacOS/CompanyFiles"
ls -l "$DMG"
