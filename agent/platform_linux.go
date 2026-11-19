//go:build linux

package main

import (
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const trayNeedsICO = false

const desktopName = "company-files-agent.desktop"

func exePath() string {
	p, _ := os.Executable()
	return p
}

func documentsDir() string {
	h, _ := os.UserHomeDir()
	if out, err := exec.Command("xdg-user-dir", "DOCUMENTS").Output(); err == nil {
		if p := strings.TrimSpace(string(out)); p != "" && p != h {
			return p
		}
	}
	return filepath.Join(h, "Documents")
}

func execLine(exe string) string {
	if strings.ContainsAny(exe, " \"'\\$`") {
		return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "`", "\\`", "$", `\$`).Replace(exe) + `"`
	}
	return exe
}

func desktopEntry(exe, args string, extra string) string {
	return "[Desktop Entry]\nType=Application\nName=" + appName + "\nComment=Saves files sent from the " + appName + " website\n" +
		"Exec=" + execLine(exe) + " " + args + "\nIcon=company-files\nTerminal=false\nCategories=Network;FileTransfer;\n" + extra
}

func autostartFile() string {
	d, _ := os.UserConfigDir()
	return filepath.Join(d, "autostart", desktopName)
}

func setAutostart(on bool) error {
	if !on {
		if err := os.Remove(autostartFile()); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(autostartFile()), 0o755); err != nil {
		return err
	}
	return os.WriteFile(autostartFile(), []byte(desktopEntry(exePath(), "--background", "NoDisplay=true\nX-GNOME-Autostart-enabled=true\n")), 0o644)
}

// The .deb installs /usr/share/applications/company-files-agent.desktop for myfiles:// links; a binary that was
// just copied somewhere gets a per-user entry instead.
func registerScheme() error {
	if _, err := os.Stat("/usr/share/applications/" + desktopName); err != nil {
		h, _ := os.UserHomeDir()
		apps := filepath.Join(h, ".local", "share", "applications")
		if err := os.MkdirAll(apps, 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(apps, desktopName), []byte(desktopEntry(exePath(), "%u", "MimeType=x-scheme-handler/"+linkScheme+";\n")), 0o644); err != nil {
			return err
		}
		_ = exec.Command("update-desktop-database", apps).Run()
	}
	return exec.Command("xdg-mime", "default", desktopName, "x-scheme-handler/"+linkScheme).Run()
}

func have(name string) bool { _, err := exec.LookPath(name); return err == nil }

func confirm(title, text string) bool {
	switch {
	case have("zenity"):
		return exec.Command("zenity", "--question", "--no-markup", "--width=460", "--title", title, "--text", text).Run() == nil
	case have("kdialog"):
		return exec.Command("kdialog", "--title", title, "--yesno", text).Run() == nil
	}
	log.Print("neither zenity nor kdialog is installed: cannot ask, so the answer is no")
	return false
}

func message(title, text string) {
	switch {
	case have("zenity"):
		_ = exec.Command("zenity", "--info", "--no-markup", "--width=460", "--title", title, "--text", text).Run()
	case have("kdialog"):
		_ = exec.Command("kdialog", "--title", title, "--msgbox", text).Run()
	case have("notify-send"):
		_ = exec.Command("notify-send", title, text).Run()
	default:
		log.Printf("%s: %s", title, text)
	}
}

func pickFolder(prompt, start string) (string, bool) {
	var out []byte
	var err error
	switch {
	case have("zenity"):
		out, err = exec.Command("zenity", "--file-selection", "--directory", "--title", prompt, "--filename", start+"/").Output()
	case have("kdialog"):
		out, err = exec.Command("kdialog", "--title", prompt, "--getexistingdirectory", start).Output()
	default:
		return "", false
	}
	p := strings.TrimSpace(string(out))
	return p, err == nil && p != ""
}

func askText(title, prompt string) (string, bool) {
	var out []byte
	var err error
	switch {
	case have("zenity"):
		out, err = exec.Command("zenity", "--entry", "--title", title, "--text", prompt).Output()
	case have("kdialog"):
		out, err = exec.Command("kdialog", "--title", title, "--inputbox", prompt).Output()
	default:
		return "", false
	}
	s := strings.TrimSpace(string(out))
	return s, err == nil && s != ""
}

func openPath(p string) { _ = exec.Command("xdg-open", p).Start() }

func openURL(u string) { _ = exec.Command("xdg-open", u).Start() }

func detach(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }

func registerURLEvents(func(string)) {}

func runHidden(*App) { select {} }

// moveToTrash follows the freedesktop.org trash spec (~/.local/share/Trash), which file managers show as Trash.
func moveToTrash(p string) error {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		h, _ := os.UserHomeDir()
		base = filepath.Join(h, ".local", "share")
	}
	trash := filepath.Join(base, "Trash")
	for _, d := range []string{"files", "info"} {
		if err := os.MkdirAll(filepath.Join(trash, d), 0o700); err != nil {
			return err
		}
	}
	name, ext := filepath.Base(p), filepath.Ext(p)
	for i := 0; i < 1000; i++ {
		n := name
		if i > 0 {
			n = fmt.Sprintf("%s.%d%s", strings.TrimSuffix(name, ext), i, ext)
		}
		info := filepath.Join(trash, "info", n+".trashinfo")
		f, err := os.OpenFile(info, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if os.IsExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		fmt.Fprintf(f, "[Trash Info]\nPath=%s\nDeletionDate=%s\n", (&url.URL{Path: p}).EscapedPath(), time.Now().Format("2006-01-02T15:04:05"))
		f.Close()
		if err := os.Rename(p, filepath.Join(trash, "files", n)); err != nil {
			os.Remove(info)
			return err // another disk: left where it is
		}
		return nil
	}
	return fmt.Errorf("no free name in the trash")
}

func installIfNeeded(string) bool { return false }

func uninstall(dir string) {
	ipcSend(dir, ipcMsg{Quit: true})
	if c := loadConfig(dir); c.Token != "" {
		_ = newAPI(c.Server, c.Token).call("POST", "/api/agent/unpair", nil, nil)
	}
	_ = setAutostart(false)
	os.RemoveAll(dir)
	fmt.Println("Disconnected and settings removed. Remove the program with: sudo apt remove company-files-agent")
}
