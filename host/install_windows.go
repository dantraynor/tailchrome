package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// chromiumBrowserTarget is one Chromium-family browser's native-messaging
// manifest target on Windows. Dir is the shared on-disk JSON directory; Path
// is the per-browser HKCU registry key path that points at the JSON.
type chromiumBrowserTarget struct {
	Name string
	Dir  string
	Path string
}

// chromiumManifestDirs returns the per-browser native-messaging manifest
// targets on Windows. Every target shares the same on-disk Dir; only the
// registry Path differs. Multiple registry keys safely point at the same
// JSON file.
func chromiumManifestDirs() []chromiumBrowserTarget {
	jsonDir := chromiumJSONDir()
	return []chromiumBrowserTarget{
		// Chrome Stable, Beta, Dev, and Canary use the Chrome native messaging
		// registry root; Canary's SxS suffix is for install/user-data paths.
		{Name: "Chrome", Dir: jsonDir, Path: `Software\Google\Chrome\NativeMessagingHosts\` + manifestNameChrome},
		{Name: "Chromium", Dir: jsonDir, Path: `Software\Chromium\NativeMessagingHosts\` + manifestNameChrome},
		{Name: "Brave", Dir: jsonDir, Path: `Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\` + manifestNameChrome},
		{Name: "Edge", Dir: jsonDir, Path: `Software\Microsoft\Edge\NativeMessagingHosts\` + manifestNameChrome},
		{Name: "Vivaldi", Dir: jsonDir, Path: `Software\Vivaldi\NativeMessagingHosts\` + manifestNameChrome},
		{Name: "Opera", Dir: jsonDir, Path: `Software\Opera Software\Opera Stable\NativeMessagingHosts\` + manifestNameChrome},
	}
}

func chromiumJSONDir() string {
	appData := os.Getenv("LOCALAPPDATA")
	return filepath.Join(appData, "Tailscale", "BrowserExt")
}

func firefoxManifestDir() string {
	appData := os.Getenv("LOCALAPPDATA")
	return filepath.Join(appData, "Tailscale", "BrowserExt")
}

func binaryInstallDir() string {
	appData := os.Getenv("LOCALAPPDATA")
	return filepath.Join(appData, "Tailscale", "BrowserExt")
}

// platformPostInstallChromium creates the HKCU registry key for the named
// Chromium-family browser pointing at the manifest JSON.
func platformPostInstallChromium(name, manifestPath string) error {
	for _, target := range chromiumManifestDirs() {
		if target.Name != name {
			continue
		}
		return createRegistryKey(registry.CURRENT_USER, target.Path, manifestPath)
	}
	return fmt.Errorf("no Windows registry path defined for browser %q", name)
}

// browserHasFootprint reports whether there is evidence on this machine that
// the named browser has ever run — either its config dir exists (Linux/macOS)
// or its vendor registry key exists (Windows). Used to label install status.
func browserHasFootprint(target chromiumBrowserTarget) bool {
	// target.Path is like `Software\Google\Chrome\NativeMessagingHosts\<name>`.
	// The vendor key is the path up to (but excluding) `NativeMessagingHosts`.
	idx := strings.LastIndex(target.Path, `\NativeMessagingHosts\`)
	if idx < 0 {
		return false
	}
	vendorKey := target.Path[:idx]
	k, err := registry.OpenKey(registry.CURRENT_USER, vendorKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	_ = k.Close()
	return true
}

// platformPostInstallFirefox creates the Windows registry key for Firefox after
// the manifest file has been written.
func platformPostInstallFirefox(manifestPath string) error {
	return createRegistryKey(
		registry.CURRENT_USER,
		`Software\Mozilla\NativeMessagingHosts\`+manifestNameFirefox,
		manifestPath,
	)
}

// platformUninstall performs Windows-specific uninstall steps:
// removing registry keys for every Chromium-family browser plus Firefox.
func platformUninstall() error {
	var firstErr error

	for _, target := range chromiumManifestDirs() {
		if err := removeRegistryKey(registry.CURRENT_USER, target.Path); err != nil && firstErr == nil {
			firstErr = err
		}
	}

	if err := removeRegistryKey(
		registry.CURRENT_USER,
		`Software\Mozilla\NativeMessagingHosts\`+manifestNameFirefox,
	); err != nil && firstErr == nil {
		firstErr = err
	}

	return firstErr
}

// createRegistryKey creates a Windows registry key pointing to the manifest JSON file.
func createRegistryKey(baseKey registry.Key, path, manifestPath string) error {
	key, _, err := registry.CreateKey(baseKey, path, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("failed to create registry key %s: %w", path, err)
	}
	defer key.Close()

	if err := key.SetStringValue("", manifestPath); err != nil {
		return fmt.Errorf("failed to set registry value: %w", err)
	}
	return nil
}

// removeRegistryKey removes a Windows registry key.
func removeRegistryKey(baseKey registry.Key, path string) error {
	err := registry.DeleteKey(baseKey, path)
	if err != nil {
		// Ignore "not found" errors during uninstall.
		return nil
	}
	return nil
}
