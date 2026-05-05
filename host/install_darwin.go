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
		{Name: "Chrome Beta", Dir: filepath.Join(appSupport, "Google", "Chrome Beta", "NativeMessagingHosts")},
		{Name: "Chrome Canary", Dir: filepath.Join(appSupport, "Google", "Chrome Canary", "NativeMessagingHosts")},
		{Name: "Chrome Dev", Dir: filepath.Join(appSupport, "Google", "Chrome Dev", "NativeMessagingHosts")},
		{Name: "Chromium", Dir: filepath.Join(appSupport, "Chromium", "NativeMessagingHosts")},
		{Name: "Brave", Dir: filepath.Join(appSupport, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts")},
		{Name: "Edge", Dir: filepath.Join(appSupport, "Microsoft Edge", "NativeMessagingHosts")},
		{Name: "Vivaldi", Dir: filepath.Join(appSupport, "Vivaldi", "NativeMessagingHosts")},
		{Name: "Opera", Dir: filepath.Join(appSupport, "com.operasoftware.Opera", "NativeMessagingHosts")},
		{Name: "Arc", Dir: filepath.Join(appSupport, "Arc", "User Data", "NativeMessagingHosts")},
	}
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

// platformPostInstallChromium is the per-browser hook used by the new
// installChromiumFamily loop. No-op on macOS.
func platformPostInstallChromium(_ string, _ string) error { return nil }

// browserHasFootprint reports whether there is evidence on this machine that
// the named browser has ever run — either its config dir exists (Linux/macOS)
// or its vendor registry key exists (Windows). Used to label install status.
func browserHasFootprint(target chromiumBrowserTarget) bool {
	_, err := os.Stat(filepath.Dir(target.Dir))
	return err == nil
}

func platformPostInstallFirefox(_ string) error { return nil }
