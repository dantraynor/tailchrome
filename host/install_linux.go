package main

import (
	"io"
	"os"
	"path/filepath"
)

// chromiumBrowserTarget is one Chromium-family browser's native-messaging
// manifest target on this platform. On Linux only Name and Dir are used.
type chromiumBrowserTarget struct {
	Name string
	Dir  string
	Path string // unused on Linux
}

// chromiumManifestDirs returns the per-browser native-messaging manifest
// directories on Linux. Writing the same manifest JSON into every directory
// ensures the extension works in whichever Chromium-family browser the user
// installs it into.
func chromiumManifestDirs() []chromiumBrowserTarget {
	home, _ := os.UserHomeDir()
	return []chromiumBrowserTarget{
		{Name: "Chrome", Dir: filepath.Join(home, ".config", "google-chrome", "NativeMessagingHosts")},
		{Name: "Chrome Beta", Dir: filepath.Join(home, ".config", "google-chrome-beta", "NativeMessagingHosts")},
		{Name: "Chrome Dev", Dir: filepath.Join(home, ".config", "google-chrome-unstable", "NativeMessagingHosts")},
		{Name: "Chromium", Dir: filepath.Join(home, ".config", "chromium", "NativeMessagingHosts")},
		{Name: "Brave", Dir: filepath.Join(home, ".config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts")},
		{Name: "Edge", Dir: filepath.Join(home, ".config", "microsoft-edge", "NativeMessagingHosts")},
		{Name: "Vivaldi", Dir: filepath.Join(home, ".config", "vivaldi", "NativeMessagingHosts")},
		{Name: "Opera", Dir: filepath.Join(home, ".config", "opera", "NativeMessagingHosts")},
	}
}

func firefoxManifestDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".mozilla", "native-messaging-hosts")
}

func binaryInstallDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "tailscale", "browser-ext")
}

// platformUninstall performs Linux-specific uninstall steps.
// On Linux there are no additional steps beyond removing manifest files.
func platformUninstall() error {
	return nil
}

// platformPostInstallChromium is the per-browser hook used by the new
// installChromiumFamily loop. No-op on Linux.
func platformPostInstallChromium(_ string, _ string) error { return nil }

// browserHasFootprint reports whether there is evidence on this machine that
// the named browser has ever run — either its config dir exists (Linux/macOS)
// or its vendor registry key exists (Windows). Used to label install status.
func browserHasFootprint(target chromiumBrowserTarget) bool {
	_, err := os.Stat(filepath.Dir(target.Dir))
	return err == nil
}

func platformPostInstallFirefox(_ string) error { return nil }

// replaceBinary installs the new host binary at destPath. A running executable
// can be overwritten in place on this platform, so this is a straight copy.
func replaceBinary(destPath string, src io.Reader, perm os.FileMode) error {
	return copyFile(destPath, src, perm)
}
