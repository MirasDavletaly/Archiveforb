// Company Files agent: sits in the tray and saves the files a person sends from the website into a folder on this
// computer, keeping the folder structure, never overwriting anything, and catching up after the computer was off.
//
//	CompanyFiles                      start (on Windows, the first run from Downloads installs it)
//	CompanyFiles myfiles://pair?…     link from the website: connect this computer (asks first)
//	CompanyFiles pair CODE [--server URL] [--folder DIR] [--yes]   connect from a terminal
//	CompanyFiles sync --once          save what is waiting, then exit
//	CompanyFiles --headless           run without a tray icon (servers, tests)
//	CompanyFiles status | --uninstall
//
// --config DIR (or COMPANYFILES_CONFIG_DIR) keeps settings elsewhere than the user's config folder.
package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
)

var (
	version       = "1.4.0"
	defaultServer = "" // -ldflags "-X main.defaultServer=https://files.example.ts.net"
	appName       = "Company Files"
	linkScheme    = "myfiles"
)

func main() {
	args := os.Args[1:]
	dir := configDir(takeFlag(&args, "--config"))
	setupLog(dir)
	// A link from the browser is the only argument; nothing after it is ever read.
	if len(args) > 0 && strings.HasPrefix(strings.ToLower(args[0]), linkScheme+":") {
		if ipcSend(dir, ipcMsg{Link: args[0]}) {
			return
		}
		runApp(dir, args[0], false)
		return
	}
	cmd := ""
	if len(args) > 0 {
		cmd = args[0]
	}
	switch cmd {
	case "pair":
		os.Exit(cliPair(dir, args[1:]))
	case "sync":
		os.Exit(cliSync(dir))
	case "status":
		c := loadConfig(dir)
		fmt.Printf("server: %s\nconnected as: %s\nfolder: %s\nhidden: %v\n", c.Server, c.User, c.folder(), c.Hidden)
	case "--uninstall":
		uninstall(dir)
	case "cloud-stop": // turn the cloud folder back into an ordinary one (downloaded files stay)
		c := loadConfig(dir)
		cloudTeardown(c)
		c.CloudRegistered = ""
		_ = c.save(dir)
	case "--headless":
		runApp(dir, "", true)
	case "--version":
		fmt.Println(version)
	default: // no arguments, --background (autostart), --installed, or macOS's own -psn_… argument
		if (cmd == "" || strings.HasPrefix(cmd, "-psn_")) && installIfNeeded(dir) {
			return
		}
		if ipcSend(dir, ipcMsg{Show: cmd != "--background"}) {
			return // already running: it shows itself
		}
		if cmd == "--installed" {
			go message(appName, "Company Files is installed and runs in the tray (notification area).\n\nTo connect this computer, open the website: Account and security → Connect this computer.")
		}
		runApp(dir, "", false)
	}
}

func takeFlag(args *[]string, name string) string {
	for i, a := range *args {
		if a == name && i+1 < len(*args) {
			v := (*args)[i+1]
			*args = append((*args)[:i:i], (*args)[i+2:]...)
			return v
		}
	}
	return ""
}

func hasFlag(args []string, name string) bool {
	for _, a := range args {
		if a == name {
			return true
		}
	}
	return false
}

func setupLog(dir string) {
	_ = os.MkdirAll(dir, 0o700)
	p := filepath.Join(dir, "agent.log")
	if st, err := os.Stat(p); err == nil && st.Size() > 1<<20 {
		_ = os.Rename(p, p+".old")
	}
	if f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		log.SetOutput(io.MultiWriter(f, os.Stderr))
	}
}

func runApp(dir, link string, headless bool) {
	a := newApp(dir, headless)
	a.firstRun()
	if err := a.serveIPC(func(m ipcMsg) { a.onIPC(m) }); err != nil {
		log.Printf("ipc: %v", err)
	}
	a.restartSync()
	log.Printf("%s agent %s started (folder %s)", appName, version, a.config().folder())
	if link != "" {
		go a.handleLink(link)
	}
	if headless {
		select {} // runs until quit through IPC or the session ends
	}
	if a.config().Hidden {
		runHidden(a) // no icon; on a Mac links still arrive as Apple events
	}
	runTray(a)
}

func (a *App) onIPC(m ipcMsg) {
	switch {
	case m.Quit:
		if a.ipc != nil {
			a.ipc.close()
		}
		os.Exit(0)
	case m.Link != "":
		a.handleLink(m.Link)
	case m.Show && !a.headless:
		if a.config().Hidden { // started again from the Start menu: bring the icon back
			_ = a.update(func(c *Config) { c.Hidden = false })
			a.relaunch()
			os.Exit(0)
		}
		message(a.config().name(), "Company Files is already running. Its icon is in the tray (notification area).")
	}
}

func cliPair(dir string, args []string) int {
	server := takeFlag(&args, "--server")
	folder := takeFlag(&args, "--folder")
	yes := hasFlag(args, "--yes")
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		fmt.Fprintln(os.Stderr, "usage: pair CODE [--server URL] [--folder DIR] [--yes]")
		return 2
	}
	a := newApp(dir, true)
	a.cli = true // the running agent (or the next start) does the syncing
	if folder != "" {
		abs, _ := filepath.Abs(folder)
		_ = a.update(func(c *Config) { c.Folder = abs })
	}
	err := a.pair(server, strings.ToUpper(args[0]), func(info PairInfo, f string) bool {
		fmt.Println(confirmText(info, f, a.config()))
		if yes {
			return true
		}
		fmt.Print("\nConnect? [y/N] ")
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		return strings.HasPrefix(strings.ToLower(strings.TrimSpace(line)), "y")
	})
	if errors.Is(err, errCancelled) {
		fmt.Println("Not connected.")
		return 1
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Could not connect:", err)
		return 1
	}
	fmt.Printf("Connected as %s. Files are saved to %s\n", a.config().User, a.config().folder())
	return 0
}

func cliSync(dir string) int {
	a := newApp(dir, true)
	if !a.paired() {
		fmt.Fprintln(os.Stderr, "This computer is not connected.")
		return 1
	}
	s := &Syncer{app: a}
	err := s.run(nilContext())
	if c := a.config(); !c.cloudMode() && !c.driveMode() {
		if merr := s.mirror(nilContext()); err == nil {
			err = merr
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
