#!/bin/sh
# Builds ../downloads/CompanyFiles.dmg on a Mac: one universal app for Intel and Apple Silicon.
# Used by .github/workflows/agent.yml; also runs on any Mac with Go and the Xcode command line tools.
#
# Signs and notarizes only when these are set (GitHub repository secrets); otherwise the app is ad-hoc signed and
# macOS asks once before opening it (right-click → Open, or System Settings → Privacy & Security → Open Anyway):
#   MACOS_CERT_P12        base64 of a "Developer ID Application" certificate exported as .p12
#   MACOS_CERT_PASSWORD   its password
# and for notarization either an App Store Connect API key (preferred: revocable, no Apple ID password involved)
#   APPLE_API_KEY (base64 of the .p8 file), APPLE_API_KEY_ID, APPLE_API_ISSUER
# or an Apple ID with an app-specific password
#   APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD
#
# Signed, the app also carries the File Provider extension (fileprovider/*.swift): files on demand in Finder, like
# OneDrive. macOS runs such an extension only when it is signed, so the unsigned build has the network drive instead.
set -eu
cd "$(dirname "$0")"
SERVER="${SERVER:-https://files.tail81e59e.ts.net}"
VERSION=$(sed -n 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' main.go | head -n 1)
TMP=build/mac
APP="$TMP/Company Files.app"
APPEX="$APP/Contents/PlugIns/CompanyFilesProvider.appex"
DMG=../downloads/CompanyFiles.dmg
rm -rf "$TMP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" ../downloads

# Go 1.27 and later build only for macOS 13 and later; Go 1.26 is the last that keeps macOS 12 Monterey.
case "$(go env GOVERSION)" in
  go1.2[7-9]*|go1.[3-9][0-9]*) echo "$(go env GOVERSION) cannot build for macOS 12; use Go 1.26" >&2; exit 1 ;;
esac
go test ./...
go run ./tools/pack icons build
iconutil -c icns build/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"

# ---- the signing identity first: its team id names the folder the app and its extension share ----
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
TEAM=$(printf '%s' "$IDENTITY" | sed -n 's/.*(\([A-Z0-9]*\))$/\1/p')
GROUP=""
[ -n "$TEAM" ] && GROUP="$TEAM.com.companyfiles"

# Runs on macOS 12 Monterey and every later version (the oldest the current Go supports). Without this the C and
# Objective-C parts would be built for the build machine's own macOS, and older Macs would refuse to start the app.
export MACOSX_DEPLOYMENT_TARGET=12.0
export CGO_CFLAGS="-mmacosx-version-min=12.0" CGO_LDFLAGS="-mmacosx-version-min=12.0"
for arch in arm64 amd64; do
  CGO_ENABLED=1 GOOS=darwin GOARCH=$arch go build -trimpath \
    -ldflags "-s -w -X main.version=$VERSION -X main.defaultServer=$SERVER -X main.appGroup=$GROUP" -o "$TMP/agent-$arch" .
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
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array>
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

# ---- the File Provider extension (signed builds only) ----
if [ -n "$GROUP" ]; then
  mkdir -p "$APPEX/Contents/MacOS"
  # which macOS the File Provider calls used here need (from the SDK's own headers), for the build log
  grep -hE 'contentPolicy|NSFileProviderContentPolicy\b|AllowsEvicting|requestDownloadForItem|evictItemWithIdentifier|protocol NSFileProviderCustomAction|performActionWithIdentifier' \
    "$(xcrun --show-sdk-path)"/System/Library/Frameworks/FileProvider.framework/Headers/*.h | sed 's/^[[:space:]]*/  sdk: /' | head -20 || true
  for arch in arm64 x86_64; do
    xcrun swiftc -swift-version 5 -O -target "$arch-apple-macos12.0" -parse-as-library -application-extension \
      -module-name CompanyFilesProvider -Xlinker -application_extension -Xlinker -e -Xlinker _NSExtensionMain \
      -framework FileProvider -framework UniformTypeIdentifiers fileprovider/*.swift -o "$TMP/provider-$arch"
  done
  lipo -create -output "$APPEX/Contents/MacOS/CompanyFilesProvider" "$TMP/provider-arm64" "$TMP/provider-x86_64"
  cat > "$APPEX/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array>
  <key>CFBundleName</key><string>Company Files</string>
  <key>CFBundleDisplayName</key><string>Company Files</string>
  <key>CFBundleIdentifier</key><string>com.companyfiles.agent.provider</string>
  <key>CFBundleExecutable</key><string>CompanyFilesProvider</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>CompanyFilesAppGroup</key><string>$GROUP</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.fileprovider-nonui</string>
    <key>NSExtensionPrincipalClass</key><string>CFFileProviderExtension</string>
    <key>NSExtensionFileProviderDocumentGroup</key><string>$GROUP</string>
    <key>NSExtensionFileProviderSupportsEnumeration</key><true/>
    <key>NSExtensionFileProviderActions</key>
    <array>
      <dict>
        <key>NSExtensionFileProviderActionIdentifier</key><string>com.companyfiles.keep</string>
        <key>NSExtensionFileProviderActionName</key><string>Always Keep on This Device</string>
        <key>NSExtensionFileProviderActionActivationRule</key>
        <string>SUBQUERY ( fileproviderItems, \$item, \$item.userInfo.keep == nil ).@count &gt; 0</string>
      </dict>
      <dict>
        <key>NSExtensionFileProviderActionIdentifier</key><string>com.companyfiles.free</string>
        <key>NSExtensionFileProviderActionName</key><string>Free Up Space</string>
        <key>NSExtensionFileProviderActionActivationRule</key><string>TRUEPREDICATE</string>
      </dict>
    </array>
  </dict>
</dict>
</plist>
EOF
  plutil -lint "$APPEX/Contents/Info.plist"
  cat > "$TMP/provider.entitlements" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.app-sandbox</key><true/>
  <key>com.apple.security.network.client</key><true/>
  <key>com.apple.security.application-groups</key><array><string>$GROUP</string></array>
</dict></plist>
EOF
  cat > "$TMP/app.entitlements" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.application-groups</key><array><string>$GROUP</string></array>
</dict></plist>
EOF
  echo "File Provider extension built (shared folder $GROUP)"
fi

if [ -n "$IDENTITY" ]; then
  # inside out: the extension (sandboxed) first, then the app around it
  [ -n "$GROUP" ] && codesign --force --options runtime --timestamp --entitlements "$TMP/provider.entitlements" --sign "$IDENTITY" "$APPEX"
  codesign --force --options runtime --timestamp ${GROUP:+--entitlements "$TMP/app.entitlements"} --sign "$IDENTITY" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
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

notarize() { # Apple checks the signed .dmg; a refusal stops the build instead of shipping an unnotarized one
  # Submit, then ask for the status every 30 s for up to 15 minutes (Mac build minutes are scarce): one dropped
  # connection while waiting (notarytool's own --wait gives up on it) must not fail the build, and a submission still
  # in Apple's queue then leaves the .dmg signed, with Apple's answer coming later (Macs check it online).
  out=$(xcrun notarytool submit "$DMG" "$@" --output-format json 2>&1) || { echo "$out"; exit 1; }
  id=$(printf '%s' "$out" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$id" ] || { echo "$out"; echo "no submission id from Apple" >&2; exit 1; }
  echo "submitted to Apple: $id"
  st=""
  i=0
  while [ $i -lt 30 ]; do
    st=$(xcrun notarytool info "$id" "$@" --output-format json 2>/dev/null | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1) || true
    case "$st" in
      Accepted) break ;;
      Invalid|Rejected) xcrun notarytool log "$id" "$@" || true; echo "notarization: $st" >&2; exit 1 ;;
    esac
    i=$((i + 1))
    sleep 30
  done
  echo "status: ${st:-unknown}"
  if [ "$st" != "Accepted" ]; then
    echo "notarization still in Apple's queue after 15 minutes (submission $id): the dmg is signed, not stapled"
    return 0
  fi
  xcrun stapler staple "$DMG"
  spctl -a -t open --context context:primary-signature -v "$DMG"
  echo "dmg notarized"
}
if [ -n "$IDENTITY" ]; then
  codesign --timestamp --sign "$IDENTITY" "$DMG"
  if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
    printf '%s' "$APPLE_API_KEY" | base64 --decode > "$TMP/notary.p8"
    notarize --key "$TMP/notary.p8" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"
    rm -f "$TMP/notary.p8"
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
    notarize --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD"
  else
    echo "dmg signed, not notarized (no notarization secrets)"
  fi
  security delete-keychain "$KC" || true
fi
lipo -archs "$APP/Contents/MacOS/CompanyFiles"
ls -l "$DMG"
