Installers of the auto-save agent, served at /downloads/<name> for the Download button on the Account page:
  CompanyFiles-Setup.exe          Windows   agent/build.ps1 (Windows) or agent/build.sh (Linux)
  company-files-agent_amd64.deb   Linux     the same scripts
  CompanyFiles.dmg                Mac       .github/workflows/agent.yml on macOS (agent/build-mac.sh), Intel + Apple Silicon
Each is signed only when a certificate is configured (see the scripts); without one it is unsigned.
