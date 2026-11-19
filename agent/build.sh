#!/bin/sh
# The same as build.ps1, on Linux (or macOS): CompanyFiles-Setup.exe and company-files-agent_amd64.deb into ../downloads.
# Signs the .exe only when SIGN_PFX (path to a .pfx) and SIGN_PASSWORD are set and osslsigncode is installed.
#   SERVER=https://files.example.ts.net sh build.sh
set -eu
cd "$(dirname "$0")"
SERVER="${SERVER:-https://files.tail81e59e.ts.net}"
VERSION=$(sed -n 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' main.go | head -n 1)
OUT=../downloads
TMP=build
FLAGS="-s -w -X main.version=$VERSION -X main.defaultServer=$SERVER"
mkdir -p "$OUT" "$TMP"
export CGO_ENABLED=0

go test ./...
go run ./tools/pack icons "$TMP"
go run ./tools/pack syso "$VERSION" rsrc_windows_amd64.syso
trap 'rm -f rsrc_windows_amd64.syso' EXIT
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$FLAGS -H windowsgui" -o "$OUT/CompanyFiles-Setup.exe" .
GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$FLAGS" -o "$TMP/company-files-agent" .
go run ./tools/pack deb "$TMP/company-files-agent" "$VERSION" "$OUT/company-files-agent_amd64.deb"

if [ -n "${SIGN_PFX:-}" ] && command -v osslsigncode >/dev/null 2>&1; then
  osslsigncode sign -pkcs12 "$SIGN_PFX" -pass "$SIGN_PASSWORD" -h sha256 -n "Company Files" \
    -ts http://timestamp.digicert.com -in "$OUT/CompanyFiles-Setup.exe" -out "$TMP/signed.exe"
  mv "$TMP/signed.exe" "$OUT/CompanyFiles-Setup.exe"
  echo "CompanyFiles-Setup.exe: signed"
else
  echo "CompanyFiles-Setup.exe: unsigned (no SIGN_PFX certificate or no osslsigncode)"
fi
ls -l "$OUT/CompanyFiles-Setup.exe" "$OUT/company-files-agent_amd64.deb"
