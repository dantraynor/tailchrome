package main

import (
	"encoding/json"
	"errors"
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
const firefoxExtensionID = "tailchrome@tesseras.org"

// nativeManifest is the native messaging host manifest format shared by
// Chromium-family browsers and Firefox.
type nativeManifest struct {
	Name              string   `json:"name"`
	Description       string   `json:"description"`
	Path              string   `json:"path"`
	Type              string   `json:"type"`
	AllowedOrigins    []string `json:"allowed_origins,omitempty"`    // Chromium-family
	AllowedExtensions []string `json:"allowed_extensions,omitempty"` // Firefox
}

// BrowserInstallResult captures per-browser status from installChromiumFamily.
type BrowserInstallResult struct {
	Name          string
	ParentExisted bool
	Err           error
}

// install parses the install argument and installs the native messaging host manifest.
// The argument format is "C<extensionID>" for the Chromium family or
// "F<extensionID>" for Firefox.
func install(arg string) error {
	if len(arg) < 2 {
		return fmt.Errorf("install argument must be C<extensionID> or F<extensionID>")
	}

	browserType := arg[0]
	extensionID := arg[1:]

	switch browserType {
	case 'C', 'c':
		_, err := installChromiumFamily(extensionID)
		return err
	case 'F', 'f':
		return installFirefox(extensionID)
	default:
		return fmt.Errorf("unknown browser type %q; use C for Chromium-family or F for Firefox", string(browserType))
	}
}

// installChromiumFamily writes the native messaging manifest into every
// supported Chromium-family browser's directory on this platform and reports
// per-browser status. Returns a non-nil error only when every browser failed.
func installChromiumFamily(extensionID string) ([]BrowserInstallResult, error) {
	binPath, err := installBinary()
	if err != nil {
		return nil, err
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

	dirs := chromiumManifestDirs()

	// Pre-pass: snapshot which browsers have a pre-existing footprint, before
	// we mutate anything. This makes "ParentExisted" mean "did this look
	// installed at the moment we started?" on every platform — important on
	// Windows where browsers share a common manifest JSON directory, so
	// stat'ing inside the loop would report a misleading footprint for
	// browsers iterated after the first.
	parentExisted := make([]bool, len(dirs))
	for i := range dirs {
		parentExisted[i] = browserHasFootprint(dirs[i])
	}

	results := make([]BrowserInstallResult, 0, len(dirs))
	successes := 0
	for i, target := range dirs {
		r := BrowserInstallResult{Name: target.Name, ParentExisted: parentExisted[i]}
		if err := installOneChromium(target, manifest); err != nil {
			r.Err = err
		} else {
			successes++
		}
		results = append(results, r)
	}

	if successes == 0 {
		errs := make([]error, 0, len(results))
		for _, r := range results {
			if r.Err != nil {
				errs = append(errs, fmt.Errorf("%s: %w", r.Name, r.Err))
			}
		}
		return results, fmt.Errorf("no Chromium-family browser manifests installed: %w", errors.Join(errs...))
	}
	return results, nil
}

// installOneChromium writes the manifest JSON into target.Dir and runs the
// per-browser platform post-install hook. Returns nil on success.
func installOneChromium(target chromiumBrowserTarget, manifest nativeManifest) error {
	if err := os.MkdirAll(target.Dir, 0755); err != nil {
		return fmt.Errorf("create dir: %w", err)
	}
	manifestPath := filepath.Join(target.Dir, manifestNameChrome+".json")
	if err := writeManifest(manifestPath, manifest); err != nil {
		return err
	}
	return platformPostInstallChromium(target.Name, manifestPath)
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

	for _, target := range chromiumManifestDirs() {
		path := filepath.Join(target.Dir, manifestNameChrome+".json")
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			if firstErr == nil {
				firstErr = fmt.Errorf("failed to remove %s manifest: %w", target.Name, err)
			}
		}
	}

	firefoxPath := filepath.Join(firefoxManifestDir(), manifestNameFirefox+".json")
	if err := os.Remove(firefoxPath); err != nil && !os.IsNotExist(err) {
		if firstErr == nil {
			firstErr = fmt.Errorf("failed to remove Firefox manifest: %w", err)
		}
	}

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
