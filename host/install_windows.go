package main

import (
	"fmt"
	"os"
	"path/filepath"

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

// chromeManifestDir returns the legacy single-browser manifest directory.
// Retained until Task 2 removes the last caller.
func chromeManifestDir() string {
	return chromiumJSONDir()
}

func firefoxManifestDir() string {
	appData := os.Getenv("LOCALAPPDATA")
	return filepath.Join(appData, "Tailscale", "BrowserExt")
}

func binaryInstallDir() string {
	appData := os.Getenv("LOCALAPPDATA")
	return filepath.Join(appData, "Tailscale", "BrowserExt")
}

// platformPostInstallChrome is the legacy single-browser hook used by the old
// installChrome flow. Creates the Chrome registry key only.
// Retained until Task 2 removes the last caller.
func platformPostInstallChrome(manifestPath string) error {
	return createRegistryKey(
		registry.CURRENT_USER,
		`Software\Google\Chrome\NativeMessagingHosts\`+manifestNameChrome,
		manifestPath,
	)
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
// removing registry keys for Chrome and Firefox native messaging hosts.
// Will be expanded in Task 2 to cover every Chromium-family browser.
func platformUninstall() error {
	var firstErr error

	if err := removeRegistryKey(
		registry.CURRENT_USER,
		`Software\Google\Chrome\NativeMessagingHosts\`+manifestNameChrome,
	); err != nil {
		firstErr = err
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

// isBrowserInstalled checks whether a browser is present on the system.
func isBrowserInstalled(browser string) bool {
	switch browser {
	case "chrome":
		localAppData := os.Getenv("LOCALAPPDATA")
		_, err := os.Stat(filepath.Join(localAppData, "Google", "Chrome", "Application", "chrome.exe"))
		if err != nil {
			progFiles := os.Getenv("PROGRAMFILES")
			_, err = os.Stat(filepath.Join(progFiles, "Google", "Chrome", "Application", "chrome.exe"))
		}
		return err == nil
	case "firefox":
		progFiles := os.Getenv("PROGRAMFILES")
		_, err := os.Stat(filepath.Join(progFiles, "Mozilla Firefox", "firefox.exe"))
		return err == nil
	}
	return false
}

// ensureWindowsRegistryKeys creates the Windows registry keys for both
// Chrome and Firefox after the manifest files have been written. Legacy;
// removed in Task 2 once nothing references it.
func ensureWindowsRegistryKeys() error {
	chromeManifest := filepath.Join(chromeManifestDir(), manifestNameChrome+".json")
	if _, err := os.Stat(chromeManifest); err == nil {
		if err := createRegistryKey(
			registry.CURRENT_USER,
			`Software\Google\Chrome\NativeMessagingHosts\`+manifestNameChrome,
			chromeManifest,
		); err != nil {
			return err
		}
	}

	firefoxManifest := filepath.Join(firefoxManifestDir(), manifestNameFirefox+".json")
	if _, err := os.Stat(firefoxManifest); err == nil {
		if err := createRegistryKey(
			registry.CURRENT_USER,
			`Software\Mozilla\NativeMessagingHosts\`+manifestNameFirefox,
			firefoxManifest,
		); err != nil {
			return err
		}
	}

	return nil
}
