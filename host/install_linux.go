package main

import (
	"os"
	"os/exec"
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

func platformPostInstallFirefox(_ string) error { return nil }

// isBrowserInstalled checks whether a browser is present on the system.
func isBrowserInstalled(browser string) bool {
	switch browser {
	case "chrome":
		_, err := exec.LookPath("google-chrome")
		if err != nil {
			_, err = exec.LookPath("google-chrome-stable")
		}
		return err == nil
	case "firefox":
		_, err := exec.LookPath("firefox")
		return err == nil
	}
	return false
}
