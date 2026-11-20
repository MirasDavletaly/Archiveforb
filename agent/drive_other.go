//go:build !darwin

package main

// The network drive is the Mac's way to files on demand (drive_darwin.go); Windows has the Cloud Files API instead.

const driveSupported = false

func (s *Syncer) runDrive(<-chan struct{}) {}

func driveOpen(*App) {}

func driveTeardown(Config) {}
