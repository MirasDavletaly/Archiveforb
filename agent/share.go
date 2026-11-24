package main

// "Share…" from the computer (decided 2026-11-24): the website's access dialog for one file or folder opens in the
// browser, ready for picking who may open or edit it, with every website rule. The item's id comes from the computer's
// own records where it has them (Windows placeholders, the Mac's File Provider), else from its path below the Company
// Files folder (the Mac's network drive, a folder copy).

import (
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// cliShare: `CompanyFiles share <file or folder>` (Explorer's and Finder's menus run it).
func cliShare(dir string, args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: share <file or folder>")
		return 2
	}
	cfg := loadConfig(dir)
	if cfg.Token == "" {
		message(appName, "This computer is not connected yet. Connect it from the website first.")
		return 1
	}
	if err := shareLocal(cfg, args[0]); err != nil {
		message(cfg.name(), "\""+filepath.Base(args[0])+"\" cannot be shared from here: "+err.Error())
		return 1
	}
	return 0
}

func shareLocal(cfg Config, p string) error {
	id, err := shareID(cfg, p)
	if err != nil {
		return err
	}
	openShare(cfg, id)
	return nil
}

// openShare opens the access dialog of item id on the website.
func openShare(cfg Config, id int64) {
	u := strings.TrimRight(cfg.Server, "/") + "/#/share/" + strconv.FormatInt(id, 10)
	log.Printf("share: the website's access dialog for item %d", id)
	if f := os.Getenv("COMPANYFILES_OPEN_LOG"); f != "" { // tests: written down instead of opening a browser
		if fh, err := os.OpenFile(f, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
			fmt.Fprintln(fh, u)
			fh.Close()
		}
		return
	}
	openURL(u)
}

// shareID: the website item a local file or folder stands for.
func shareID(cfg Config, p string) (int64, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return 0, err
	}
	if id, ok := localItemID(cfg, abs); ok {
		if id <= 0 { // the cloud folder itself, "Shared with me" and the like: not one item on the website
			return 0, errors.New("only files and folders inside it can be shared")
		}
		return id, nil
	}
	for _, top := range shareTops(cfg) {
		rel, err := filepath.Rel(top, abs)
		if top == "" || err != nil || rel == "." || strings.HasPrefix(rel, "..") {
			continue
		}
		var out struct {
			ID int64 `json:"id"`
		}
		err = newAPI(cfg.Server, cfg.Token).call("GET", "/api/agent/cloud-path?path="+url.QueryEscape(filepath.ToSlash(rel)), nil, &out)
		if statusOf(err) == 404 {
			return 0, errors.New("it is not on the website (yet)")
		}
		return out.ID, err
	}
	return 0, errors.New("it is not in the " + cfg.name() + " folder")
}
