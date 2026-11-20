package main

import (
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"sync"
	"time"
)

// App is the running agent: its settings, the sync loop and what the tray shows.
type App struct {
	dir      string
	headless bool // no tray and no system changes (tests, servers)
	mu       sync.Mutex
	cfg      Config
	status   string
	last     string // last saved file, for the tray
	syncer   *Syncer
	pairing  sync.Mutex
	onChange func() // the tray repaints itself
	ipc      *ipcServer
	cli      bool // a one-off command (pair from a terminal): links, but starts no syncing
}

func newApp(dir string, headless bool) *App {
	return &App{dir: dir, headless: headless, cfg: loadConfig(dir)}
}

func (a *App) config() Config {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg
}

func (a *App) update(fn func(*Config)) error {
	a.mu.Lock()
	fn(&a.cfg)
	c := a.cfg
	a.mu.Unlock()
	a.changed()
	return c.save(a.dir)
}

func (a *App) changed() {
	if f := a.onChange; f != nil {
		f()
	}
}

func (a *App) paired() bool { c := a.config(); return c.Token != "" && c.Server != "" }

// statusLine is the first line of the tray menu.
func (a *App) statusLine() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	switch {
	case a.cfg.Token == "":
		return "Not connected. Connect from the website."
	case a.status != "":
		return a.status
	default:
		return fmt.Sprintf("Connected as %s · up to date", a.cfg.User)
	}
}

func (a *App) setStatus(s string) {
	a.mu.Lock()
	same := a.status == s
	a.status = s
	a.mu.Unlock()
	if !same {
		a.changed()
	}
}

func (a *App) saved(path string) {
	a.mu.Lock()
	a.last = path
	a.mu.Unlock()
}

// firstRun sets up start-with-the-computer and the myfiles:// link once, on a real desktop.
func (a *App) firstRun() {
	if a.headless || a.config().Initialized {
		return
	}
	if err := setAutostart(true); err != nil {
		log.Printf("autostart: %v", err)
	}
	if err := registerScheme(); err != nil {
		log.Printf("link registration: %v", err)
	}
	_ = a.update(func(c *Config) { c.Autostart, c.Initialized = true, true })
}

func (a *App) restartSync() {
	a.mu.Lock()
	old := a.syncer
	a.syncer = nil
	a.mu.Unlock()
	if old != nil {
		old.stop()
	}
	if !a.paired() {
		a.changed()
		return
	}
	s := startSyncer(a)
	a.mu.Lock()
	a.syncer = s
	a.mu.Unlock()
}

// unpaired: the server no longer accepts the token (disconnected on the website, or the account was blocked).
func (a *App) unpaired() {
	if !a.paired() {
		return
	}
	log.Print("the server no longer accepts this computer; disconnecting")
	_ = a.update(func(c *Config) { c.Token, c.DeviceID = "", 0 })
	a.setStatus("")
	go func() {
		a.restartSync()
		a.endCloud()
	}()
	if !a.headless {
		go message(a.config().name(), "This computer was disconnected from "+a.config().name()+" (on the website, or by IT). Files already saved stay in the folder.")
	}
}

var errCancelled = errors.New("cancelled")

// pair links this computer with the code from the website, after the person confirms whose account it is.
func (a *App) pair(server, code string, confirm func(PairInfo, string) bool) error {
	if !a.pairing.TryLock() {
		return errors.New("already connecting")
	}
	defer a.pairing.Unlock()
	if server == "" {
		server = defaultServer
	}
	server, err := checkServer(server)
	if err != nil {
		return err
	}
	api := newAPI(server, "")
	var info PairInfo
	if err := api.call("POST", "/api/agent/pair-info", map[string]string{"code": code}, &info); err != nil {
		if h := statusOf(err); h == 404 || h == 429 {
			return errors.New(err.(*httpError).Msg)
		}
		return fmt.Errorf("cannot reach %s: %w", server, err)
	}
	folder := Config{AppName: info.AppName, Folder: a.config().Folder}.folder()
	if !confirm(info, folder) {
		return errCancelled
	}
	var res PairResult
	if err := api.call("POST", "/api/agent/pair", map[string]string{"code": code, "name": computerName(), "os": osName()}, &res); err != nil {
		if h, ok := err.(*httpError); ok && h.Msg != "" {
			return errors.New(h.Msg)
		}
		return err
	}
	old := a.config()
	if old.Token != "" && old.Server == server {
		_ = newAPI(old.Server, old.Token).call("POST", "/api/agent/unpair", nil, nil) // replaced: retire the old link
	}
	if err := a.update(func(c *Config) {
		c.Server, c.Token, c.DeviceID, c.User, c.AppName = server, res.Token, res.Device.ID, res.User.Name, res.AppName
		if c.Folder == "" {
			c.Folder = folder
		}
	}); err != nil {
		return err
	}
	_ = os.MkdirAll(folder, 0o755)
	if !a.cli {
		a.restartSync()
	}
	return nil
}

func confirmText(info PairInfo, folder string, current Config) string {
	host := info.Server
	if u, err := url.Parse(info.Server); err == nil {
		host = u.Host
	}
	s := fmt.Sprintf("Connect this computer to %s?\n\nAccount: %s (%s)\nServer: %s\n\nFiles you send from the website will be saved to:\n%s", info.AppName, info.User.Name, info.User.Login, host, folder)
	if current.Token != "" {
		s += fmt.Sprintf("\n\nThis replaces the current connection (%s).", current.User)
	}
	return s + "\n\nOnly continue if you opened this link yourself just now."
}

// handleLink processes a myfiles:// link (from the website) on the desktop: confirm, link, report.
func (a *App) handleLink(link string) {
	code, server, err := parseLink(link)
	if err == nil {
		err = a.pair(server, code, func(info PairInfo, folder string) bool {
			return confirm(info.AppName, confirmText(info, folder, a.config()))
		})
	}
	switch {
	case err == nil:
		c := a.config()
		switch {
		case c.cloudMode():
			message(c.name(), fmt.Sprintf("This computer is connected as %s.\n\n%s is now in File Explorer, on the left (like OneDrive): everything you can open on the website, downloaded when you open it. Folder: %s", c.User, c.name(), cloudRoot(c)))
		case c.driveMode():
			message(c.name(), fmt.Sprintf("This computer is connected as %s.\n\n%s is now in Finder, on the left (under Locations, and in Favorites): everything you can open on the website, downloaded when you open it.", c.User, c.name()))
		default:
			message(c.name(), fmt.Sprintf("This computer is connected as %s.\n\nSelect files on the website and press Enter: they are saved to\n%s", c.User, c.folder()))
		}
	case errors.Is(err, errCancelled):
	default:
		log.Printf("pairing: %v", err)
		message(appName, "Could not connect this computer: "+err.Error())
	}
}

func (a *App) disconnect() {
	c := a.config()
	if c.Token != "" {
		if err := newAPI(c.Server, c.Token).call("POST", "/api/agent/unpair", nil, nil); err != nil && statusOf(err) != 401 {
			log.Printf("unpair: %v", err)
		}
	}
	_ = a.update(func(c *Config) { c.Token, c.DeviceID = "", 0 })
	a.setStatus("")
	a.restartSync()
	a.endCloud()
}

// endCloud: this computer stopped syncing; the cloud folder becomes an ordinary folder (downloaded files stay).
func (a *App) endCloud() {
	c := a.config()
	driveTeardown(c) // Mac: the network drive is disconnected
	if c.CloudRegistered == "" {
		return
	}
	time.Sleep(time.Second) // the provider has let go of the folder
	cloudTeardown(c)
	_ = a.update(func(c *Config) { c.CloudRegistered = "" })
}

// moveCloud puts the cloud folder somewhere else: the old one becomes ordinary, the new one fills as it is opened.
func (a *App) moveCloud(to string) {
	a.mu.Lock()
	old := a.syncer
	a.syncer = nil
	a.mu.Unlock()
	if old != nil {
		old.stop()
	}
	a.endCloud()
	_ = a.update(func(c *Config) { c.CloudRoot = to })
	a.restartSync()
}

// relaunch starts a fresh copy of the agent (used to switch hidden mode on and off) and lets this one end.
func (a *App) relaunch() {
	if a.ipc != nil {
		a.ipc.close()
	}
	exe, err := os.Executable()
	if err == nil {
		cmd := exec.Command(exe, "--background")
		detach(cmd)
		err = cmd.Start()
	}
	if err != nil {
		log.Printf("relaunch: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
}
