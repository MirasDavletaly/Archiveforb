package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// One agent runs per person. A second start (a myfiles:// link from the browser, or the Start menu) hands its
// request to the running one over 127.0.0.1 and exits. The address and a secret live in a file only this user can
// read, so neither web pages nor other users can talk to the agent.
type ipcMsg struct {
	Link string `json:"link,omitempty"`
	Show bool   `json:"show,omitempty"`
	Quit bool   `json:"quit,omitempty"`
}

type ipcFile struct {
	Port   int    `json:"port"`
	Secret string `json:"secret"`
}

type ipcServer struct {
	ln   net.Listener
	path string
}

func ipcSend(dir string, m ipcMsg) bool {
	b, err := os.ReadFile(filepath.Join(dir, "ipc.json"))
	if err != nil {
		return false
	}
	var f ipcFile
	if json.Unmarshal(b, &f) != nil || f.Port == 0 {
		return false
	}
	body, _ := json.Marshal(m)
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/ipc", f.Port), bytes.NewReader(body))
	req.Header.Set("X-Secret", f.Secret)
	res, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return false
	}
	res.Body.Close()
	return res.StatusCode == http.StatusNoContent
}

func (a *App) serveIPC(handle func(ipcMsg)) error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	raw := make([]byte, 32)
	_, _ = rand.Read(raw)
	secret := hex.EncodeToString(raw)
	port := ln.Addr().(*net.TCPAddr).Port
	host := fmt.Sprintf("127.0.0.1:%d", port)
	b, _ := json.Marshal(ipcFile{port, secret})
	_ = os.MkdirAll(a.dir, 0o700)
	path := filepath.Join(a.dir, "ipc.json")
	if err := os.WriteFile(path, b, 0o600); err != nil {
		ln.Close()
		return err
	}
	a.ipc = &ipcServer{ln, path}
	srv := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Host check stops DNS rebinding; the secret stops everything else.
		if r.Method != "POST" || r.URL.Path != "/ipc" || r.Host != host || r.Header.Get("X-Secret") != secret || r.Header.Get("Origin") != "" {
			http.Error(w, "no", http.StatusForbidden)
			return
		}
		var m ipcMsg
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&m) != nil {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		go handle(m)
	})}
	go srv.Serve(ln)
	return nil
}

func (s *ipcServer) close() {
	s.ln.Close()
	os.Remove(s.path)
}
