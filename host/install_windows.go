package main

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows/registry"
)

func chromeManifestDir() string {
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

// platformPostInstallChrome creates the Windows registry key for Chrome after
// the manifest file has been written.
func platformPostInstallChrome(manifestPath string) error {
	return createRegistryKey(
		registry.CURRENT_USER,
		`Software\Google\Chrome\NativeMessagingHosts\`+manifestNameChrome,
		manifestPath,
	)
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
func platformUninstall() error {
	var firstErr error

	// Remove Chrome registry key.
	if err := removeRegistryKey(
		registry.CURRENT_USER,
		`Software\Google\Chrome\NativeMessagingHosts\`+manifestNameChrome,
	); err != nil {
		firstErr = err
	}

	// Remove Firefox registry key.
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
		// Check common Chrome install location on Windows.
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
// Chrome and Firefox after the manifest files have been written.
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
