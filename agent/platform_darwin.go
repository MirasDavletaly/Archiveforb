//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

const trayNeedsICO = false

const launchLabel = "com.companyfiles.agent"

func exePath() string {
	p, _ := os.Executable()
	return p
}

func documentsDir() string {
	h, _ := os.UserHomeDir()
	return filepath.Join(h, "Documents")
}

func plistPath() string {
	h, _ := os.UserHomeDir()
	return filepath.Join(h, "Library", "LaunchAgents", launchLabel+".plist")
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

func setAutostart(on bool) error {
	if !on {
		if err := os.Remove(plistPath()); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(plistPath()), 0o755); err != nil {
		return err
	}
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>` + launchLabel + `</string>
  <key>ProgramArguments</key><array><string>` + xmlEscape(exePath()) + `</string><string>--background</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
`
	return os.WriteFile(plistPath(), []byte(plist), 0o644)
}

// The .app's Info.plist declares myfiles:// links; macOS registers it when the app is first opened.
func registerScheme() error { return nil }

func asQuote(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

func osascript(script string) (string, error) {
	out, err := exec.Command("osascript", "-e", script).Output()
	return strings.TrimSpace(string(out)), err
}

func confirm(title, text string) bool {
	_, err := osascript(`display dialog ` + asQuote(text) + ` with title ` + asQuote(title) + ` buttons {"Cancel", "OK"} default button "OK" with icon note`)
	return err == nil
}

func message(title, text string) {
	_, _ = osascript(`display dialog ` + asQuote(text) + ` with title ` + asQuote(title) + ` buttons {"OK"} default button "OK"`)
}

func pickFolder(prompt, start string) (string, bool) {
	out, err := osascript(`POSIX path of (choose folder with prompt ` + asQuote(prompt) + ` default location (POSIX file ` + asQuote(start) + `))`)
	out = strings.TrimSuffix(out, "/")
	return out, err == nil && out != ""
}

func askText(title, prompt string) (string, bool) {
	out, err := osascript(`text returned of (display dialog ` + asQuote(prompt) + ` default answer "" with title ` + asQuote(title) + `)`)
	return out, err == nil && out != ""
}

func openPath(p string) { _ = exec.Command("open", p).Start() }

func openURL(u string) { _ = exec.Command("open", u).Start() }

func detach(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }

// installIfNeeded: run straight from the opened .dmg (or from the temporary copy macOS makes of apps opened in
// Downloads), start-with-the-computer would point at a path that goes away; ask to move it to Applications first.
func installIfNeeded(string) bool {
	p := exePath()
	if strings.HasPrefix(p, "/Volumes/") || strings.Contains(p, "/AppTranslocation/") {
		message(appName, "Drag Company Files into the Applications folder first, then open it from there.")
		return true
	}
	return false
}

func uninstall(dir string) {
	ipcSend(dir, ipcMsg{Quit: true})
	if c := loadConfig(dir); c.Token != "" {
		_ = newAPI(c.Server, c.Token).call("POST", "/api/agent/unpair", nil, nil)
	}
	_ = setAutostart(false)
	os.RemoveAll(dir)
	fmt.Println("Disconnected and settings removed. Drag Company Files from Applications to the Trash to remove the app.")
}
