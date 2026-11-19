package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSafeJoin(t *testing.T) {
	root := t.TempDir()
	good := map[string]string{
		"report.docx":           "report.docx",
		"Projects/Apollo/a.pdf": filepath.Join("Projects", "Apollo", "a.pdf"),
		"Договор № 15.docx":     "Договор № 15.docx",
		"con.txt":               "_con.txt",
		"Folder./file. ":        filepath.Join("Folder", "file"),
		"a/LPT1/b":              filepath.Join("a", "_LPT1", "b"),
	}
	for in, want := range good {
		got, err := safeJoin(root, in)
		if err != nil || got != filepath.Join(root, want) {
			t.Errorf("safeJoin(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	bad := []string{
		"", "../x", "a/../../x", "..", ".", "a/./b", "/etc/passwd", `..\x`, `a\b`, "C:/Windows/x", "c:x",
		"a//b", "a/", "x\x00y", "tab\there", "...", " ", "a/ ./b", "what?", `quo"te`, "pipe|x", "<x>",
	}
	for _, in := range bad {
		if got, err := safeJoin(root, in); err == nil {
			t.Errorf("safeJoin(%q) = %q, want refusal", in, got)
		}
	}
}

func TestPlaceFileNeverOverwrites(t *testing.T) {
	dir := t.TempDir()
	want := filepath.Join(dir, "report.docx")
	os.WriteFile(want, []byte("old"), 0o644)
	for i, content := range []string{"new1", "new2"} {
		tmp := filepath.Join(dir, ".part")
		os.WriteFile(tmp, []byte(content), 0o644)
		got, err := placeFile(tmp, want)
		if err != nil {
			t.Fatal(err)
		}
		if exp := filepath.Join(dir, []string{"report (1).docx", "report (2).docx"}[i]); got != exp {
			t.Errorf("got %q, want %q", got, exp)
		}
		if b, _ := os.ReadFile(got); string(b) != content {
			t.Errorf("content %q", b)
		}
	}
	if b, _ := os.ReadFile(want); string(b) != "old" {
		t.Errorf("the existing file was overwritten: %q", b)
	}
	if _, err := os.Stat(filepath.Join(dir, ".part")); !os.IsNotExist(err) {
		t.Error("temporary file left behind")
	}
}

func TestInsideRootRefusesSymlinkEscape(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating symbolic links needs extra rights on Windows")
	}
	root, outside := t.TempDir(), t.TempDir()
	os.Symlink(outside, filepath.Join(root, "link"))
	if insideRoot(root, filepath.Join(root, "link")) {
		t.Error("a symlink leading outside was accepted")
	}
	os.Mkdir(filepath.Join(root, "real"), 0o755)
	if !insideRoot(root, filepath.Join(root, "real")) {
		t.Error("a real subfolder was refused")
	}
}

func TestParseLink(t *testing.T) {
	code, server, err := parseLink("myfiles://pair?code=AB12-CD34&server=https%3A%2F%2Ffiles.example.ts.net")
	if err != nil || code != "AB12-CD34" || server != "https://files.example.ts.net" {
		t.Errorf("got %q %q %v", code, server, err)
	}
	if _, _, err := parseLink("myfiles://evil?code=x"); err == nil {
		t.Error("unknown action accepted")
	}
	for _, s := range []string{"http://files.example.ts.net", "https://user@x.ts.net", "ftp://x", "https://", "javascript:alert(1)"} {
		if _, err := checkServer(s); err == nil {
			t.Errorf("checkServer(%q) accepted", s)
		}
	}
	for in, want := range map[string]string{"https://files.example.ts.net/": "https://files.example.ts.net", "http://127.0.0.1:8800": "http://127.0.0.1:8800", "http://localhost:1": "http://localhost:1"} {
		if got, err := checkServer(in); err != nil || got != want {
			t.Errorf("checkServer(%q) = %q, %v", in, got, err)
		}
	}
}
