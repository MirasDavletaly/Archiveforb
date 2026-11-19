// Build helper (not part of the agent): draws the icon files and packs the Linux .deb, so the installers build the
// same way on Windows, Linux and macOS without dpkg or image tools.
//
//	go run ./tools/pack icons DIR                 icon-<size>.png, app.ico and a macOS AppIcon.iconset
//	go run ./tools/pack syso VERSION OUT          Windows resources (icon, manifest) for the amd64 .exe
//	go run ./tools/pack deb BINARY VERSION OUT    company-files-agent .deb for amd64
package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"companyfiles/agent/icon"
)

func main() {
	if len(os.Args) < 3 {
		fail("usage: pack icons DIR | pack deb BINARY VERSION OUT")
	}
	switch os.Args[1] {
	case "icons":
		icons(os.Args[2])
	case "syso":
		if len(os.Args) != 4 {
			fail("usage: pack syso VERSION OUT")
		}
		syso(os.Args[2], os.Args[3])
	case "deb":
		if len(os.Args) != 5 {
			fail("usage: pack deb BINARY VERSION OUT")
		}
		deb(os.Args[2], os.Args[3], os.Args[4])
	default:
		fail("unknown command " + os.Args[1])
	}
}

func fail(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	os.Exit(1)
}

func must(err error) {
	if err != nil {
		fail(err.Error())
	}
}

func icons(dir string) {
	set := filepath.Join(dir, "AppIcon.iconset")
	must(os.MkdirAll(set, 0o755))
	for _, s := range []int{16, 32, 48, 64, 128, 256, 512, 1024} {
		must(os.WriteFile(filepath.Join(dir, fmt.Sprintf("icon-%d.png", s)), icon.PNG(s), 0o644))
	}
	for _, s := range []int{16, 32, 128, 256, 512} { // the names iconutil expects
		must(os.WriteFile(filepath.Join(set, fmt.Sprintf("icon_%dx%d.png", s, s)), icon.PNG(s), 0o644))
		must(os.WriteFile(filepath.Join(set, fmt.Sprintf("icon_%dx%d@2x.png", s, s)), icon.PNG(2*s), 0o644))
	}
	must(os.WriteFile(filepath.Join(dir, "app.ico"), icon.ICO(16, 32, 48, 256), 0o644))
}

// The manifest runs the program as the user who started it (no admin prompt, even though the file name says
// "Setup"), gives dialogs the current Windows look and keeps them sharp on high-DPI screens.
const manifest = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity type="win32" name="CompanyFiles.Agent" version="%s" processorArchitecture="amd64"/>
  <description>Company Files auto-save agent</description>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application>
    <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
  </application></compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings>
    <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
    <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">permonitorv2,permonitor</dpiAwareness>
  </windowsSettings></application>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges>
    <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
  </requestedPrivileges></security></trustInfo>
  <dependency><dependentAssembly>
    <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
  </dependentAssembly></dependency>
</assembly>
`

type resource struct {
	typ, id uint32
	data    []byte
}

// syso writes a COFF object with a .rsrc section (icon group + manifest) that the Go linker puts into the .exe.
// Layout: resource directory (type → id → language) → data entries → data; each data entry's address is relocated.
func syso(version, out string) {
	const rtIcon, rtGroupIcon, rtManifest = 3, 14, 24
	le := binary.LittleEndian
	parts := strings.Split(version, ".")
	for len(parts) < 4 {
		parts = append(parts, "0")
	}
	var list []resource
	var grp bytes.Buffer
	sizes := []int{16, 20, 24, 32, 40, 48, 64, 256}
	binary.Write(&grp, le, [3]uint16{0, 1, uint16(len(sizes))})
	for i, s := range sizes {
		p := icon.PNG(s) // PNG images inside icons work since Windows Vista
		list = append(list, resource{rtIcon, uint32(i + 1), p})
		d := uint8(s)
		if s >= 256 {
			d = 0
		}
		grp.Write([]byte{d, d, 0, 0})
		binary.Write(&grp, le, [2]uint16{1, 32})
		binary.Write(&grp, le, uint32(len(p)))
		binary.Write(&grp, le, uint16(i+1))
	}
	list = append(list, resource{rtGroupIcon, 1, grp.Bytes()}, resource{rtManifest, 1, []byte(fmt.Sprintf(manifest, strings.Join(parts[:4], ".")))})
	types := []uint32{rtIcon, rtGroupIcon, rtManifest} // directory entries must be sorted by id
	byType := map[uint32][]resource{}
	for _, r := range list {
		byType[r.typ] = append(byType[r.typ], r)
	}
	var order []resource
	off := 16 + 8*len(types)
	typeDir := map[uint32]int{}
	for _, t := range types {
		typeDir[t] = off
		off += 16 + 8*len(byType[t])
		order = append(order, byType[t]...)
	}
	langDir, dataEntry, dataAt := make([]int, len(order)), make([]int, len(order)), make([]int, len(order))
	for i := range order {
		langDir[i] = off
		off += 16 + 8
	}
	for i := range order {
		dataEntry[i] = off
		off += 16
	}
	for i, r := range order {
		off = (off + 7) &^ 7
		dataAt[i] = off
		off += len(r.data)
	}
	raw := make([]byte, (off+7)&^7)
	dir := func(at, n int) { le.PutUint16(raw[at+14:], uint16(n)) } // NumberOfIdEntries
	dir(0, len(types))
	i := 0
	for k, t := range types {
		le.PutUint32(raw[16+8*k:], t)
		le.PutUint32(raw[16+8*k+4:], uint32(typeDir[t])|0x80000000)
		dir(typeDir[t], len(byType[t]))
		for j, r := range byType[t] {
			e := typeDir[t] + 16 + 8*j
			le.PutUint32(raw[e:], r.id)
			le.PutUint32(raw[e+4:], uint32(langDir[i])|0x80000000)
			dir(langDir[i], 1)
			le.PutUint32(raw[langDir[i]+16:], 0x0409)
			le.PutUint32(raw[langDir[i]+20:], uint32(dataEntry[i]))
			le.PutUint32(raw[dataEntry[i]:], uint32(dataAt[i])) // + the section's address, by relocation
			le.PutUint32(raw[dataEntry[i]+4:], uint32(len(r.data)))
			copy(raw[dataAt[i]:], r.data)
			i++
		}
	}
	var f bytes.Buffer
	relocAt := 20 + 40 + len(raw)
	symAt := relocAt + 10*len(order)
	binary.Write(&f, le, struct {
		Machine, Sections          uint16
		Time, SymTable, Symbols    uint32
		OptHeader, Characteristics uint16
	}{0x8664, 1, 0, uint32(symAt), 1, 0, 0})
	name := [8]byte{'.', 'r', 's', 'r', 'c'}
	binary.Write(&f, le, struct {
		Name                                      [8]byte
		VirtualSize, VirtualAddress, RawSize, Raw uint32
		Relocs, Lines                             uint32
		NRelocs, NLines                           uint16
		Characteristics                           uint32
	}{name, 0, 0, uint32(len(raw)), 60, uint32(relocAt), 0, uint16(len(order)), 0, 0x40000040}) // initialized data, readable
	f.Write(raw)
	for i := range order {
		binary.Write(&f, le, struct {
			At   uint32
			Sym  uint32
			Type uint16
		}{uint32(dataEntry[i]), 0, 3}) // IMAGE_REL_AMD64_ADDR32NB
	}
	binary.Write(&f, le, struct {
		Name       [8]byte
		Value      uint32
		Section    int16
		Type       uint16
		Class, Aux uint8
	}{name, 0, 1, 0, 3, 0}) // the section symbol, static
	binary.Write(&f, le, uint32(4)) // empty string table
	must(os.WriteFile(out, f.Bytes(), 0o644))
}

type entry struct {
	name string
	mode int64
	data []byte // nil: a directory
}

func targz(entries []entry) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	now := time.Now()
	for _, e := range entries {
		h := &tar.Header{Name: e.name, Mode: e.mode, ModTime: now, Uname: "root", Gname: "root", Format: tar.FormatGNU}
		if e.data == nil {
			h.Typeflag = tar.TypeDir
		} else {
			h.Typeflag = tar.TypeReg
			h.Size = int64(len(e.data))
		}
		must(tw.WriteHeader(h))
		if e.data != nil {
			_, err := tw.Write(e.data)
			must(err)
		}
	}
	must(tw.Close())
	must(gz.Close())
	return buf.Bytes()
}

func deb(binary, version, out string) {
	bin, err := os.ReadFile(binary)
	must(err)
	desktop := "[Desktop Entry]\nType=Application\nName=Company Files\nComment=Saves files sent from the Company Files website\n" +
		"Exec=/usr/bin/company-files-agent %u\nIcon=company-files\nTerminal=false\nCategories=Network;FileTransfer;\n" +
		"MimeType=x-scheme-handler/myfiles;\n"
	data := []entry{{"./", 0o755, nil}, {"./usr/", 0o755, nil}, {"./usr/bin/", 0o755, nil}, {"./usr/bin/company-files-agent", 0o755, bin},
		{"./usr/share/", 0o755, nil}, {"./usr/share/applications/", 0o755, nil},
		{"./usr/share/applications/company-files-agent.desktop", 0o644, []byte(desktop)},
		{"./usr/share/icons/", 0o755, nil}, {"./usr/share/icons/hicolor/", 0o755, nil}}
	for _, s := range []int{48, 128, 256} {
		d := fmt.Sprintf("./usr/share/icons/hicolor/%dx%d/", s, s)
		data = append(data, entry{d, 0o755, nil}, entry{d + "apps/", 0o755, nil}, entry{d + "apps/company-files.png", 0o644, icon.PNG(s)})
	}
	size := 0
	for _, e := range data {
		size += len(e.data)
	}
	control := strings.Join([]string{
		"Package: company-files-agent",
		"Version: " + version,
		"Architecture: amd64",
		"Maintainer: Company Files IT <it@company-files.invalid>",
		fmt.Sprintf("Installed-Size: %d", (size+1023)/1024),
		"Recommends: zenity | kdialog, xdg-utils",
		"Section: net",
		"Priority: optional",
		"Description: Company Files auto-save agent",
		" Sits in the tray and saves the files you send from the Company Files website",
		" into a folder on this computer, keeping the folder structure.",
	}, "\n") + "\n"
	hook := "#!/bin/sh\nset -e\ncommand -v update-desktop-database >/dev/null && update-desktop-database -q /usr/share/applications || true\n" +
		"command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q /usr/share/icons/hicolor || true\n"
	ctrl := []entry{{"./", 0o755, nil}, {"./control", 0o644, []byte(control)}, {"./postinst", 0o755, []byte(hook)}, {"./postrm", 0o755, []byte(hook)}}

	// A .deb is an ar archive: debian-binary, control.tar.gz, data.tar.gz, in this order.
	var ar bytes.Buffer
	ar.WriteString("!<arch>\n")
	member := func(name string, body []byte) {
		fmt.Fprintf(&ar, "%-16s%-12d%-6d%-6d%-8o%-10d`\n", name, time.Now().Unix(), 0, 0, 0o100644, len(body))
		ar.Write(body)
		if len(body)%2 == 1 {
			ar.WriteByte('\n')
		}
	}
	member("debian-binary", []byte("2.0\n"))
	member("control.tar.gz", targz(ctrl))
	member("data.tar.gz", targz(data))
	must(os.WriteFile(out, ar.Bytes(), 0o644))
}
