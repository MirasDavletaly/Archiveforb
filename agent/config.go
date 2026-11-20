package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Config is kept in the user's config folder, readable only by them (it holds the computer's token).
type Config struct {
	Server      string `json:"server,omitempty"`
	Token       string `json:"token,omitempty"`
	DeviceID    int64  `json:"device_id,omitempty"`
	User        string `json:"user,omitempty"`
	AppName     string `json:"app_name,omitempty"`
	Folder      string `json:"folder,omitempty"`
	Hidden      bool   `json:"hidden,omitempty"`
	Autostart   bool   `json:"autostart"`
	Initialized bool   `json:"initialized"`
	// Files on demand (Windows): where the cloud folder is (default %USERPROFILE%\<name>), and the registration that
	// is in place ("id|folder"), so it is redone only when one of them changes. NoCloud keeps the older folder sync.
	CloudRoot       string `json:"cloud_root,omitempty"`
	CloudRegistered string `json:"cloud_registered,omitempty"`
	NoCloud         bool   `json:"no_cloud,omitempty"`
}

// CloudProvider names the cloud folder registration with Windows (tests use their own, so they never touch a real one).
func (c Config) CloudProvider() string {
	if p := os.Getenv("COMPANYFILES_CLOUD_PROVIDER"); p != "" {
		return p
	}
	return "CompanyFiles"
}

// cloudMode: files on demand instead of the My files folder copy.
func (c Config) cloudMode() bool { return cloudSupported && !c.NoCloud }

func configDir(override string) string {
	if override != "" {
		return override
	}
	if d := os.Getenv("COMPANYFILES_CONFIG_DIR"); d != "" {
		return d
	}
	d, err := os.UserConfigDir()
	if err != nil {
		d = os.TempDir()
	}
	return filepath.Join(d, "CompanyFiles")
}

func loadConfig(dir string) Config {
	var c Config
	if b, err := os.ReadFile(filepath.Join(dir, "agent.json")); err == nil {
		_ = json.Unmarshal(b, &c)
	}
	return c
}

func (c Config) save(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	tmp := filepath.Join(dir, "agent.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, "agent.json"))
}

func (c Config) name() string {
	if c.AppName != "" {
		return c.AppName
	}
	return appName
}

func (c Config) folder() string {
	if c.Folder != "" {
		return c.Folder
	}
	return filepath.Join(documentsDir(), c.name())
}
