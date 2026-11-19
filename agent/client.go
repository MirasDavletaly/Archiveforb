package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"
)

// API talks to the Files server. Only HTTPS is accepted, except plain HTTP to this machine (for testing).
type API struct {
	Server string
	Token  string
	http   *http.Client
}

type httpError struct {
	Status int
	Msg    string
}

func (e *httpError) Error() string { return fmt.Sprintf("%d %s", e.Status, e.Msg) }

func statusOf(err error) int {
	var h *httpError
	if errors.As(err, &h) {
		return h.Status
	}
	return 0
}

func newAPI(server, token string) *API {
	return &API{Server: server, Token: token, http: &http.Client{Timeout: 60 * time.Second}}
}

func userAgent() string { return fmt.Sprintf("CompanyFilesAgent/%s (%s)", version, runtime.GOOS) }

func (a *API) request(method, path string, body any) (*http.Response, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, a.Server+path, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent())
	req.Header.Set("X-Requested-With", "fetch")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if a.Token != "" {
		req.Header.Set("Authorization", "Bearer "+a.Token)
	}
	res, err := a.http.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		defer res.Body.Close()
		var e struct{ Error string }
		b, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		_ = json.Unmarshal(b, &e)
		return nil, &httpError{res.StatusCode, e.Error}
	}
	return res, nil
}

func (a *API) call(method, path string, body, out any) error {
	res, err := a.request(method, path, body)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if out == nil {
		_, _ = io.Copy(io.Discard, res.Body)
		return nil
	}
	return json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(out)
}

type PairInfo struct {
	AppName string `json:"appName"`
	Server  string `json:"server"`
	User    struct {
		Name  string `json:"name"`
		Login string `json:"login"`
	} `json:"user"`
}

type PairResult struct {
	Token  string `json:"token"`
	Device struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	} `json:"device"`
	User struct {
		Name  string `json:"name"`
		Login string `json:"login"`
	} `json:"user"`
	AppName string `json:"appName"`
}

type QueueItem struct {
	ID       int64  `json:"id"`
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
}

func computerName() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "Computer"
	}
	return strings.TrimSuffix(h, ".local")
}

func osName() string {
	if runtime.GOOS == "darwin" {
		return "macos"
	}
	return runtime.GOOS
}

// checkServer accepts https://host[:port] (no user info, path ignored), or http only to this machine.
func checkServer(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || u.User != nil || u.Opaque != "" {
		return "", errors.New("not a server address")
	}
	host := u.Hostname()
	local := host == "localhost" || (net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback())
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return "", errors.New("the server must use https")
	}
	return u.Scheme + "://" + u.Host, nil
}

// parseLink reads myfiles://pair?code=XXXX-XXXX&server=https://… (the link the website opens).
func parseLink(link string) (code, server string, err error) {
	u, err := url.Parse(link)
	if err != nil || !strings.EqualFold(u.Scheme, linkScheme) {
		return "", "", errors.New("not a " + linkScheme + " link")
	}
	action := u.Host
	if action == "" {
		action = strings.Trim(u.Opaque+u.Path, "/")
	}
	if !strings.EqualFold(action, "pair") {
		return "", "", errors.New("unknown link")
	}
	q := u.Query()
	code = strings.ToUpper(strings.TrimSpace(q.Get("code")))
	if code == "" {
		return "", "", errors.New("the link has no code")
	}
	return code, q.Get("server"), nil
}
