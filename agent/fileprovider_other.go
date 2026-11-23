//go:build !darwin

package main

// Apple's File Provider exists only on a Mac (fileprovider_darwin.go).

func fpSupported() bool { return false }

func (s *Syncer) runFileProvider(<-chan struct{}) {}

func fpOpen(*App) {}

func fpTeardown(Config) {}

func cliKeep(bool, []string) int { return 2 }
