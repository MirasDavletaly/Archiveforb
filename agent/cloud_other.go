//go:build !windows

package main

// Files on demand needs the Windows Cloud Files API; on a Mac it would need Apple's File Provider, which only runs in
// apps signed with an Apple Developer ID. Elsewhere the agent keeps My files as a folder copy (mirror.go).

const cloudSupported = false

func (s *Syncer) runCloud(<-chan struct{}) {}

func cloudTeardown(Config) {}

func cloudRoot(cfg Config) string { return cfg.folder() }
