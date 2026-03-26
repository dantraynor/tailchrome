package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

// manifestName is the name used for the native messaging host registration.
const manifestNameChrome = "com.tailscale.browserext.chrome"
const manifestNameFirefox = "com.tailscale.browserext.firefox"

// chromeWebStoreExtensionID is the stable extension ID assigned by the Chrome Web Store.
const chromeWebStoreExtensionID = "bhfeceecialgilpedkoflminjgcjljll"

// firefoxExtensionID is the gecko addon ID for the Firefox extension.
const firefoxExtensionID = "tailchrome@tailscale.com"

// chromeManifest is the native messaging host manifest for Chrome.
type nativeManifest struct {
	Name              string   `json:"name"`
	Description       string   `json:"description"`
	Path              string   `json:"path"`
	Type              string   `json:"type"`
	AllowedOrigins    []string `json:"allowed_origins,omitempty"`    // Chrome
	AllowedExtensions []string `json:"allowed_extensions,omitempty"` // Firefox
}

// install parses the install argument and installs the native messaging host manifest.
// The argument format is "C<extensionID>" for Chrome or "F<extensionID>" for Firefox.
func install(arg string) error {
	if len(arg) < 2 {
		return fmt.Errorf("install argument must be C<extensionID> or F<extensionID>")
	}

	browserType := arg[0]
	extensionID := arg[1:]

	switch browserType {
	case 'C', 'c':
		return installChrome(extensionID)
	case 'F', 'f':
		return installFirefox(extensionID)
	default:
		return fmt.Errorf("unknown browser type %q; use C for Chrome or F for Firefox", string(browserType))
	}
}

// installChrome installs the native messaging host for Chrome.
func installChrome(extensionID string) error {
	dir := chromeManifestDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create manifest dir: %w", err)
	}

	binPath, err := installBinary()
	if err != nil {
		return err
	}

	manifest := nativeManifest{
		Name:        manifestNameChrome,
		Description: "Tailscale Browser Extension Native Messaging Host",
		Path:        binPath,
		Type:        "stdio",
		AllowedOrigins: []string{
			fmt.Sprintf("chrome-extension://%s/", extensionID),
		},
	}

	manifestPath := filepath.Join(dir, manifestNameChrome+".json")
	if err := writeManifest(manifestPath, manifest); err != nil {
		return err
	}
	return platformPostInstallChrome(manifestPath)
}

// installFirefox installs the native messaging host for Firefox.
func installFirefox(extensionID string) error {
	dir := firefoxManifestDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create manifest dir: %w", err)
	}

	binPath, err := installBinary()
	if err != nil {
		return err
	}

	manifest := nativeManifest{
		Name:        manifestNameFirefox,
		Description: "Tailscale Browser Extension Native Messaging Host",
		Path:        binPath,
		Type:        "stdio",
		AllowedExtensions: []string{
			extensionID,
		},
	}

	manifestPath := filepath.Join(dir, manifestNameFirefox+".json")
	if err := writeManifest(manifestPath, manifest); err != nil {
		return err
	}
	return platformPostInstallFirefox(manifestPath)
}

// uninstall removes the native messaging host manifest files.
func uninstall() error {
	var firstErr error

	// Remove Chrome manifest.
	chromePath := filepath.Join(chromeManifestDir(), manifestNameChrome+".json")
	if err := os.Remove(chromePath); err != nil && !os.IsNotExist(err) {
		firstErr = fmt.Errorf("failed to remove Chrome manifest: %w", err)
	}

	// Remove Firefox manifest.
	firefoxPath := filepath.Join(firefoxManifestDir(), manifestNameFirefox+".json")
	if err := os.Remove(firefoxPath); err != nil && !os.IsNotExist(err) {
		if firstErr == nil {
			firstErr = fmt.Errorf("failed to remove Firefox manifest: %w", err)
		}
	}

	// Platform-specific cleanup (e.g., Windows registry).
	if err := platformUninstall(); err != nil && firstErr == nil {
		firstErr = err
	}

	return firstErr
}

// installBinary copies the current binary to the install directory and returns
// the installed path.
func installBinary() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("failed to get executable path: %w", err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return "", fmt.Errorf("failed to resolve executable path: %w", err)
	}

	installDir := binaryInstallDir()
	if err := os.MkdirAll(installDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create install dir: %w", err)
	}

	binaryName := "tailscale-browser-ext"
	if runtime.GOOS == "windows" {
		binaryName += ".exe"
	}
	destPath := filepath.Join(installDir, binaryName)

	// If the source and destination are the same, skip the copy.
	if exe == destPath {
		return destPath, nil
	}

	src, err := os.Open(exe)
	if err != nil {
		return "", fmt.Errorf("failed to open source binary: %w", err)
	}
	defer src.Close()

	dst, err := os.OpenFile(destPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0755)
	if err != nil {
		return "", fmt.Errorf("failed to create destination binary: %w", err)
	}
	defer dst.Close()

	if _, err := io.Copy(dst, src); err != nil {
		return "", fmt.Errorf("failed to copy binary: %w", err)
	}

	return destPath, nil
}

// writeManifest writes a native messaging host manifest JSON file.
func writeManifest(path string, manifest nativeManifest) error {
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal manifest: %w", err)
	}

	if err := os.WriteFile(path, data, 0644); err != nil {
		return fmt.Errorf("failed to write manifest: %w", err)
	}

	return nil
}
