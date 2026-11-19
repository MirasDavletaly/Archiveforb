# Builds the auto-save agent installers into ..\downloads, where the website's Download button finds them:
#   CompanyFiles-Setup.exe          Windows (the program installs itself for the user on first run, no admin rights)
#   company-files-agent_amd64.deb   Linux
# The Mac .dmg is built on macOS by .github/workflows/agent.yml (build-mac.sh). build.sh does the same as this on Linux.
#
# The .exe is signed only when a certificate is available: SIGN_PFX (path to a .pfx) and SIGN_PASSWORD in the
# environment, and signtool (Windows SDK) installed. Otherwise it stays unsigned.
#   powershell -File build.ps1 [-Server https://files.example.ts.net]
param([string]$Server = 'https://files.tail81e59e.ts.net')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$version = [regex]::Match((Get-Content -Raw -Encoding UTF8 main.go), 'version\s*=\s*"([^"]+)"').Groups[1].Value
$out = (New-Item -ItemType Directory -Force (Join-Path $PSScriptRoot '..\downloads')).FullName
$tmp = (New-Item -ItemType Directory -Force (Join-Path $PSScriptRoot 'build')).FullName
$flags = "-s -w -X main.version=$version -X main.defaultServer=$Server"
$env:CGO_ENABLED = '0'
Remove-Item Env:GOOS, Env:GOARCH -ErrorAction SilentlyContinue

function Invoke-Go { go @args; if ($LASTEXITCODE) { throw "go $($args -join ' ') failed" } }

Invoke-Go test ./...
Invoke-Go run ./tools/pack icons $tmp
Invoke-Go run ./tools/pack syso $version rsrc_windows_amd64.syso
try {
  $env:GOOS = 'windows'; $env:GOARCH = 'amd64'
  Invoke-Go build -trimpath -ldflags "$flags -H windowsgui" -o "$out\CompanyFiles-Setup.exe" .
  $env:GOOS = 'linux'
  Invoke-Go build -trimpath -ldflags $flags -o "$tmp\company-files-agent" .
} finally {
  Remove-Item rsrc_windows_amd64.syso -ErrorAction SilentlyContinue
  Remove-Item Env:GOOS, Env:GOARCH -ErrorAction SilentlyContinue
}
Invoke-Go run ./tools/pack deb "$tmp\company-files-agent" $version "$out\company-files-agent_amd64.deb"

$signtool = (Get-Command signtool -ErrorAction SilentlyContinue).Source
if (-not $signtool) { $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue | Where-Object FullName -match '\\x64\\' | Select-Object -Last 1 -ExpandProperty FullName }
if ($env:SIGN_PFX -and $signtool) {
  & $signtool sign /f $env:SIGN_PFX /p $env:SIGN_PASSWORD /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /d 'Company Files' "$out\CompanyFiles-Setup.exe"
  if ($LASTEXITCODE) { throw 'signing failed' }
  Write-Host 'CompanyFiles-Setup.exe: signed'
} else {
  Write-Host 'CompanyFiles-Setup.exe: unsigned (no SIGN_PFX certificate or no signtool)'
}
Get-Item "$out\CompanyFiles-Setup.exe", "$out\company-files-agent_amd64.deb" | ForEach-Object { '{0}  {1:N1} MB' -f $_.Name, ($_.Length / 1MB) }
