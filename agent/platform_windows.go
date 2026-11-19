//go:build windows

package main

import (
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const trayNeedsICO = true

const (
	runKey       = `Software\Microsoft\Windows\CurrentVersion\Run`
	uninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\CompanyFiles`
	runValue     = "CompanyFiles"
)

func exePath() string {
	p, _ := os.Executable()
	return p
}

func installDir() string { return filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "CompanyFiles") }

func shortcutPath() string {
	return filepath.Join(os.Getenv("APPDATA"), `Microsoft\Windows\Start Menu\Programs`, appName+".lnk")
}

func documentsDir() string {
	if p, err := windows.KnownFolderPath(windows.FOLDERID_Documents, 0); err == nil && p != "" {
		return p
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, "Documents")
}

func setValue(path, name, value string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(name, value)
}

func setAutostartFor(exe string, on bool) error {
	if !on {
		k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
		if err != nil {
			return nil
		}
		defer k.Close()
		if err := k.DeleteValue(runValue); err != nil && err != registry.ErrNotExist {
			return err
		}
		return nil
	}
	return setValue(runKey, runValue, `"`+exe+`" --background`)
}

func setAutostart(on bool) error { return setAutostartFor(exePath(), on) }

// myfiles:// links open "CompanyFiles.exe" "<link>"; the link is one quoted argument and nothing else is read.
func registerSchemeFor(exe string) error {
	base := `Software\Classes\` + linkScheme
	for _, v := range [][3]string{
		{base, "", "URL:" + appName},
		{base, "URL Protocol", ""},
		{base + `\DefaultIcon`, "", exe + ",0"},
		{base + `\shell\open\command`, "", `"` + exe + `" "%1"`},
	} {
		if err := setValue(v[0], v[1], v[2]); err != nil {
			return err
		}
	}
	return nil
}

func registerScheme() error { return registerSchemeFor(exePath()) }

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}

func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200} // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
}

func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

func powershell(script string) (string, error) {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command",
		"[Console]::OutputEncoding = [Text.Encoding]::UTF8; "+script)
	hideWindow(cmd)
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

func messageBox(title, text string, flags uint32) int32 {
	t, _ := windows.UTF16PtrFromString(title)
	m, _ := windows.UTF16PtrFromString(text)
	r, _ := windows.MessageBox(0, m, t, flags|0x00040000|0x00010000) // MB_TOPMOST | MB_SETFOREGROUND
	return r
}

func confirm(title, text string) bool { return messageBox(title, text, 0x4|0x20) == 6 } // MB_YESNO|MB_ICONQUESTION -> IDYES

func message(title, text string) { messageBox(title, text, 0x40) } // MB_ICONINFORMATION

func pickFolder(prompt, start string) (string, bool) {
	out, err := powershell(`Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; ` +
		`$d.Description = ` + psQuote(prompt) + `; $d.SelectedPath = ` + psQuote(start) + `; $d.ShowNewFolderButton = $true; ` +
		`if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }`)
	return out, err == nil && out != ""
}

func askText(title, prompt string) (string, bool) {
	out, err := powershell(`Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::InputBox(` + psQuote(prompt) + `, ` + psQuote(title) + `, '')`)
	return out, err == nil && out != ""
}

func openPath(p string) { _ = exec.Command("explorer.exe", p).Start() }

func openURL(u string) {
	verb, _ := windows.UTF16PtrFromString("open")
	file, _ := windows.UTF16PtrFromString(u)
	_ = windows.ShellExecute(0, verb, file, nil, nil, windows.SW_SHOWNORMAL)
}

func registerURLEvents(func(string)) {}

func runHidden(*App) { select {} }

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := to + ".new"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, to)
}

// installIfNeeded: the downloaded CompanyFiles-Setup.exe installs itself for this user (no admin rights needed)
// into %LOCALAPPDATA%\Programs\CompanyFiles, adds a Start menu entry, starts with Windows, registers myfiles://
// links and an entry in Settings → Apps for removal. Running a newer setup updates in place.
func installIfNeeded(dir string) bool {
	exe := exePath()
	target := filepath.Join(installDir(), "CompanyFiles.exe")
	if strings.EqualFold(filepath.Clean(exe), filepath.Clean(target)) {
		return false
	}
	if ipcSend(dir, ipcMsg{Quit: true}) {
		time.Sleep(1500 * time.Millisecond) // let the running copy exit and release its file
	}
	err := os.MkdirAll(installDir(), 0o755)
	for i := 0; err == nil && i < 10; i++ {
		if err = copyFile(exe, target); err == nil {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if err != nil {
		message(appName, "Could not install Company Files: "+err.Error())
		return true
	}
	steps := []error{registerSchemeFor(target), setAutostartFor(target, true), addUninstallEntry(target)}
	if _, err := powershell(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut(` + psQuote(shortcutPath()) + `); $s.TargetPath = ` + psQuote(target) + `; $s.Description = 'Saves files sent from the Company Files website'; $s.Save()`); err != nil {
		steps = append(steps, fmt.Errorf("start menu shortcut: %w", err))
	}
	for _, e := range steps {
		if e != nil {
			log.Printf("install: %v", e)
		}
	}
	c := loadConfig(dir)
	c.Autostart, c.Initialized = true, true
	_ = c.save(dir)
	cmd := exec.Command(target, "--installed")
	detach(cmd)
	if err := cmd.Start(); err != nil {
		message(appName, "Company Files is installed. Open it from the Start menu.")
	}
	return true
}

func addUninstallEntry(target string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, uninstallKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	for name, v := range map[string]string{
		"DisplayName": appName, "DisplayVersion": version, "Publisher": appName, "DisplayIcon": target,
		"UninstallString": `"` + target + `" --uninstall`, "InstallLocation": installDir(),
	} {
		if err := k.SetStringValue(name, v); err != nil {
			return err
		}
	}
	size := uint32(0)
	if st, err := os.Stat(target); err == nil {
		size = uint32(st.Size() / 1024)
	}
	_ = k.SetDWordValue("EstimatedSize", size)
	_ = k.SetDWordValue("NoModify", 1)
	return k.SetDWordValue("NoRepair", 1)
}

func deleteTree(path string) {
	k, err := registry.OpenKey(registry.CURRENT_USER, path, registry.ENUMERATE_SUB_KEYS)
	if err == nil {
		names, _ := k.ReadSubKeyNames(-1)
		k.Close()
		for _, n := range names {
			deleteTree(path + `\` + n)
		}
	}
	_ = registry.DeleteKey(registry.CURRENT_USER, path)
}

func uninstall(dir string) {
	if !confirm(appName, "Remove Company Files from this computer?\n\nFiles it already saved stay where they are.") {
		return
	}
	if ipcSend(dir, ipcMsg{Quit: true}) { // the copy in the tray: wait until it has let go of its files
		for i := 0; i < 50; i++ {
			if _, err := os.Stat(filepath.Join(dir, "ipc.json")); os.IsNotExist(err) {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		time.Sleep(500 * time.Millisecond)
	}
	if c := loadConfig(dir); c.Token != "" {
		_ = newAPI(c.Server, c.Token).call("POST", "/api/agent/unpair", nil, nil)
	}
	_ = setAutostartFor("", false)
	deleteTree(`Software\Classes\` + linkScheme)
	deleteTree(uninstallKey)
	os.Remove(shortcutPath())
	// A running program cannot delete its own .exe or its open log, so a hidden command removes the program and
	// settings folders once this one has exited (after the person closes the message below).
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", fmt.Sprintf(
		"Wait-Process -Id %d -Timeout 600 -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 300; Remove-Item -LiteralPath %s, %s -Recurse -Force -ErrorAction SilentlyContinue",
		os.Getpid(), psQuote(installDir()), psQuote(dir)))
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		log.Printf("uninstall: %v", err)
	}
	message(appName, "Company Files was removed from this computer.")
}
