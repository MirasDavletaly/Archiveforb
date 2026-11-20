package main

import (
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"

	"companyfiles/agent/icon"

	"fyne.io/systray"
)

func nilContext() context.Context { return context.Background() }

func trayIcon() []byte {
	if trayNeedsICO {
		return icon.ICO(16, 32, 48)
	}
	return icon.PNG(64)
}

func runTray(a *App) {
	systray.Run(func() { a.trayReady() }, func() {
		if a.ipc != nil {
			a.ipc.close()
		}
	})
}

func (a *App) trayReady() {
	systray.SetIcon(trayIcon())
	systray.SetTooltip(a.config().name())
	status := systray.AddMenuItem(a.statusLine(), "")
	status.Disable()
	systray.AddSeparator()
	open := systray.AddMenuItem("Open the folder", "")
	folder := systray.AddMenuItem("Change folder…", "")
	code := systray.AddMenuItem("Connect with a code…", "")
	site := systray.AddMenuItem("Open the website", "")
	systray.AddSeparator()
	auto := systray.AddMenuItemCheckbox("Start with the computer", "", a.config().Autostart)
	hidden := systray.AddMenuItem("Hidden mode (no icon)", "")
	disc := systray.AddMenuItem("Disconnect this computer", "")
	systray.AddSeparator()
	quit := systray.AddMenuItem("Quit", "")

	paint := func() {
		line := a.statusLine()
		status.SetTitle(line)
		systray.SetTooltip(a.config().name() + "\n" + line)
		if a.paired() {
			disc.Enable()
		} else {
			disc.Disable()
		}
	}
	a.onChange = paint
	paint()
	registerURLEvents(func(link string) { go a.handleLink(link) }) // macOS delivers links as Apple events

	go func() {
		for {
			select {
			case <-open.ClickedCh:
				if c := a.config(); a.paired() && (c.fpMode() || c.driveMode()) {
					if c.fpMode() {
						go fpOpen(a)
					} else {
						go driveOpen(a)
					}
					continue
				}
				p := a.config().folder()
				if a.config().cloudMode() {
					p = cloudRoot(a.config())
				}
				_ = os.MkdirAll(p, 0o755)
				openPath(p)
			case <-folder.ClickedCh:
				if c := a.config(); c.cloudMode() {
					cur := cloudRoot(c)
					if p, ok := pickFolder("Choose where the Company Files cloud folder goes (a new, empty folder)", filepath.Dir(cur)); ok && p != "" && !strings.EqualFold(p, cur) {
						go a.moveCloud(p)
						message(c.name(), "The cloud folder is now:\n"+p+"\n\nFiles you downloaded before stay in the old folder as ordinary files.")
					}
					continue
				}
				cur := a.config().folder()
				if p, ok := pickFolder("Choose where Company Files saves files", cur); ok && p != "" && p != cur {
					_ = a.update(func(c *Config) { c.Folder = p })
					message(a.config().name(), "New files will be saved to:\n"+p+"\n\nFiles saved before stay where they are.")
				}
			case <-code.ClickedCh:
				go a.askCode()
			case <-site.ClickedCh:
				s := a.config().Server
				if s == "" {
					s = defaultServer
				}
				if s != "" {
					openURL(s + "/#/account")
				}
			case <-auto.ClickedCh:
				on := !auto.Checked()
				if err := setAutostart(on); err != nil {
					message(appName, "Could not change this: "+err.Error())
					continue
				}
				_ = a.update(func(c *Config) { c.Autostart = on })
				if on {
					auto.Check()
				} else {
					auto.Uncheck()
				}
			case <-hidden.ClickedCh:
				if confirm(appName, "Hide the Company Files icon?\n\nFiles keep being saved in the background. To show the icon again, open Company Files from the Start menu (or run it again).") {
					_ = a.update(func(c *Config) { c.Hidden = true })
					a.relaunch()
					systray.Quit()
					return
				}
			case <-disc.ClickedCh:
				if confirm(appName, "Disconnect this computer?\n\nNothing more will be saved here until you connect it again. Files already saved stay in the folder.") {
					a.disconnect()
				}
			case <-quit.ClickedCh:
				systray.Quit()
				return
			}
		}
	}()
}

// askCode is the fallback when the browser could not open the app: type the code shown on the website.
func (a *App) askCode() {
	code, ok := askText(appName, "Enter the code shown on the website (Account and security → Connect this computer):")
	code = strings.ToUpper(strings.TrimSpace(code))
	if !ok || code == "" {
		return
	}
	server := a.config().Server
	err := a.pair(server, code, func(info PairInfo, folder string) bool {
		return confirm(info.AppName, confirmText(info, folder, a.config()))
	})
	switch {
	case err == nil:
		message(a.config().name(), "This computer is connected as "+a.config().User+".")
	case errors.Is(err, errCancelled):
	default:
		log.Printf("pairing: %v", err)
		message(appName, "Could not connect this computer: "+err.Error())
	}
}
