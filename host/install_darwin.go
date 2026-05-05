package main

import (
	"os"
	"path/filepath"
)

// chromiumBrowserTarget is one Chromium-family browser's native-messaging
// manifest target on this platform. On macOS only Name and Dir are used.
type chromiumBrowserTarget struct {
	Name string
	Dir  string
	Path string // unused on macOS
}

// chromiumManifestDirs returns the per-browser native-messaging manifest
// directories on macOS. Includes Arc (macOS-only at time of writing).
func chromiumManifestDirs() []chromiumBrowserTarget {
	home, _ := os.UserHomeDir()
	appSupport := filepath.Join(home, "Library", "Application Support")
	return []chromiumBrowserTarget{
		{Name: "Chrome", Dir: filepath.Join(appSupport, "Google", "Chrome", "NativeMessagingHosts")},
		{Name: "Chromium", Dir: filepath.Join(appSupport, "Chromium", "NativeMessagingHosts")},
		{Name: "Brave", Dir: filepath.Join(appSupport, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts")},
		{Name: "Edge", Dir: filepath.Join(appSupport, "Microsoft Edge", "NativeMessagingHosts")},
		{Name: "Vivaldi", Dir: filepath.Join(appSupport, "Vivaldi", "NativeMessagingHosts")},
		{Name: "Opera", Dir: filepath.Join(appSupport, "com.operasoftware.Opera", "NativeMessagingHosts")},
		{Name: "Arc", Dir: filepath.Join(appSupport, "Arc", "User Data", "NativeMessagingHosts")},
	}
}

// chromeManifestDir returns the legacy single-browser manifest directory.
// Retained until Task 2 removes the last caller.
func chromeManifestDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
}

func firefoxManifestDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts")
}

func binaryInstallDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "Application Support", "Tailscale", "BrowserExt")
}

// platformUninstall performs macOS-specific uninstall steps.
// On macOS there are no additional steps beyond removing manifest files.
func platformUninstall() error {
	return nil
}

// platformPostInstallChrome is the legacy single-browser hook. Retained until
// Task 2 removes its last caller.
func platformPostInstallChrome(_ string) error  { return nil }

// platformPostInstallChromium is the per-browser hook used by the new
// installChromiumFamily loop. No-op on macOS.
func platformPostInstallChromium(_ string, _ string) error { return nil }

func platformPostInstallFirefox(_ string) error { return nil }

// isBrowserInstalled checks whether a browser is present on the system.
func isBrowserInstalled(browser string) bool {
	switch browser {
	case "chrome":
		_, err := os.Stat("/Applications/Google Chrome.app")
		return err == nil
	case "firefox":
		_, err := os.Stat("/Applications/Firefox.app")
		return err == nil
	}
	return false
}
