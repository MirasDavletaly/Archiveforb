package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var errBadPath = errors.New("unsafe path")

// Windows device names: "con.txt" opens the console, not a file.
var reservedName = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$`)

// safeJoin turns a path sent by the server ("Folder/Sub/file.docx", always "/"-separated) into a path inside root.
// Anything that could climb out (.., absolute paths, drive letters, backslashes) or that Windows treats specially
// is refused or neutralised; the result is checked to really be below root.
func safeJoin(root, rel string) (string, error) {
	if rel == "" || len(rel) > 1000 || strings.HasPrefix(rel, "/") || strings.ContainsAny(rel, "\\\x00") {
		return "", errBadPath
	}
	parts := strings.Split(rel, "/")
	if len(parts) > 64 {
		return "", errBadPath
	}
	clean := []string{root}
	for _, p := range parts {
		if p == "" || p == "." || p == ".." || len(p) > 255 || strings.ContainsAny(p, `:*?"<>|`) {
			return "", errBadPath
		}
		for _, r := range p {
			if r < 0x20 || r == 0x7f {
				return "", errBadPath
			}
		}
		p = strings.TrimRight(p, ". ") // Windows silently drops trailing dots and spaces
		if p == "" {
			return "", errBadPath
		}
		if reservedName.MatchString(p) {
			p = "_" + p
		}
		clean = append(clean, p)
	}
	full := filepath.Join(clean...)
	r, err := filepath.Rel(root, full)
	if err != nil || r == "." || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) || filepath.IsAbs(r) {
		return "", errBadPath
	}
	return full, nil
}

// insideRoot checks, after folders were created, that dir does not lead out of root through a symbolic link.
func insideRoot(root, dir string) bool {
	rr, err1 := filepath.EvalSymlinks(root)
	dd, err2 := filepath.EvalSymlinks(dir)
	if err1 != nil || err2 != nil {
		return false
	}
	r, err := filepath.Rel(rr, dd)
	return err == nil && r != ".." && !strings.HasPrefix(r, ".."+string(filepath.Separator)) && !filepath.IsAbs(r)
}

// uniquePath never lets a save overwrite anything: "report.docx" becomes "report (1).docx", "report (2).docx", …
func uniquePath(p string) string {
	if _, err := os.Lstat(p); os.IsNotExist(err) {
		return p
	}
	ext := filepath.Ext(p)
	base := strings.TrimSuffix(p, ext)
	for i := 1; i < 10000; i++ {
		c := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if _, err := os.Lstat(c); os.IsNotExist(err) {
			return c
		}
	}
	return fmt.Sprintf("%s (%d)%s", base, time.Now().UnixNano(), ext)
}

// placeFile moves a finished download to its final name without ever replacing an existing file: a hard link
// fails if the name is taken (then the next free name is tried); where links are not supported, it renames.
func placeFile(tmp, want string) (string, error) {
	for i := 0; i < 50; i++ {
		final := uniquePath(want)
		err := os.Link(tmp, final)
		if err == nil {
			os.Remove(tmp)
			return final, nil
		}
		if os.IsExist(err) {
			continue
		}
		if _, statErr := os.Lstat(final); statErr == nil {
			continue
		}
		return final, os.Rename(tmp, final) // file systems without hard links (FAT, exFAT)
	}
	return "", errors.New("no free file name")
}
