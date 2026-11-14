package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	chromeFlatpakID  = "com.google.Chrome"
	firefoxFlatpakID = "org.mozilla.firefox"
)

// flatpakBrowser describes one Flatpak-packaged browser that can launch the
// helper from inside its sandbox. Every artifact lives under the app's own
// ~/.var/app/<AppID> directory, which the sandbox sees at the same path, so no
// filesystem override is needed.
type flatpakBrowser struct {
	Name  string // display name, e.g. "Chrome"
	AppID string // Flatpak application ID
	// ManifestRel is the native-messaging manifest path relative to the app
	// directory, as the browser resolves it inside the sandbox.
	ManifestRel string
	// SupportsExtensionDir reports whether an unpacked extension bundle can be
	// staged alongside the helper (Chromium only).
	SupportsExtensionDir bool
}

var (
	chromeFlatpak = flatpakBrowser{
		Name:                 "Chrome",
		AppID:                chromeFlatpakID,
		ManifestRel:          "config/google-chrome/NativeMessagingHosts/" + manifestNameChrome + ".json",
		SupportsExtensionDir: true,
	}
	// Firefox reads ~/.mozilla/native-messaging-hosts, which the Flathub
	// package persists under the app directory.
	firefoxFlatpak = flatpakBrowser{
		Name:        "Firefox",
		AppID:       firefoxFlatpakID,
		ManifestRel: ".mozilla/native-messaging-hosts/" + manifestNameFirefox + ".json",
	}
)

func flatpakBrowserForAppID(appID string) (flatpakBrowser, bool) {
	for _, b := range []flatpakBrowser{chromeFlatpak, firefoxFlatpak} {
		if b.AppID == appID {
			return b, true
		}
	}
	return flatpakBrowser{}, false
}

// hostStateDir keeps the historical native state location stable. A helper
// launched by a supported Flatpak browser is a different installation and must
// use the app's writable configuration tree instead.
func hostStateDir(homeDir, initID string) (string, error) {
	if !validInitID.MatchString(initID) {
		return "", errors.New("invalid Flatpak sandbox state root: invalid profile ID")
	}
	b, ok := flatpakBrowserForAppID(os.Getenv("FLATPAK_ID"))
	if !ok {
		return filepath.Join(homeDir, ".config", "tailscale-browser-ext", initID), nil
	}

	configRoot := os.Getenv("XDG_CONFIG_HOME")
	if configRoot == "" {
		configRoot = filepath.Join(flatpakAppDir(homeDir, b), "config")
	}
	if err := validateFlatpakConfigRoot(homeDir, b, configRoot); err != nil {
		return "", err
	}
	stateDir := filepath.Join(configRoot, "tailscale-browser-ext", initID)
	if err := rejectPathSymlinks(stateDir); err != nil {
		return "", fmt.Errorf("invalid %s Flatpak sandbox state root: %w", b.Name, err)
	}
	if info, err := os.Lstat(stateDir); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return "", fmt.Errorf("invalid %s Flatpak sandbox state root %q: profile state must be a directory, not a symlink or file", b.Name, stateDir)
		}
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("invalid %s Flatpak sandbox state root %q: %w", b.Name, stateDir, err)
	}
	return stateDir, nil
}

func flatpakAppDir(homeDir string, b flatpakBrowser) string {
	return filepath.Join(homeDir, ".var", "app", b.AppID)
}

func validateFlatpakConfigRoot(homeDir string, b flatpakBrowser, configRoot string) error {
	if configRoot == "" || !filepath.IsAbs(configRoot) {
		return fmt.Errorf("invalid %s Flatpak sandbox state root: XDG_CONFIG_HOME must be an absolute path inside the %s Flatpak app directory", b.Name, b.Name)
	}
	configRoot = filepath.Clean(configRoot)
	appDir := filepath.Clean(flatpakAppDir(homeDir, b))
	expectedParent := filepath.Join(appDir, "config")
	if err := rejectPathSymlinks(appDir); err != nil {
		return fmt.Errorf("invalid %s Flatpak sandbox state root: %w", b.Name, err)
	}
	if !pathWithinFlatpak(appDir, configRoot) || configRoot == appDir || !pathWithinFlatpak(expectedParent, configRoot) {
		return fmt.Errorf("invalid %s Flatpak sandbox state root %q: XDG_CONFIG_HOME must be inside %q", b.Name, configRoot, expectedParent)
	}
	if err := rejectPathSymlinks(configRoot); err != nil {
		return fmt.Errorf("invalid %s Flatpak sandbox state root: %w", b.Name, err)
	}
	// Do not allow an existing symlink to redirect state outside the app. The
	// host init path creates missing directories after this check.
	if info, err := os.Lstat(configRoot); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return fmt.Errorf("invalid %s Flatpak sandbox state root %q: must be a directory, not a symlink or file", b.Name, configRoot)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("invalid %s Flatpak sandbox state root %q: %w", b.Name, configRoot, err)
	}
	stateRoot := filepath.Join(configRoot, "tailscale-browser-ext")
	if err := rejectPathSymlinks(stateRoot); err != nil {
		return fmt.Errorf("invalid %s Flatpak sandbox state root: %w", b.Name, err)
	}
	return nil
}

func pathWithinFlatpak(root, candidate string) bool {
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(candidate))
	return err == nil && rel != ".." && !(len(rel) > 3 && rel[:3] == ".."+string(filepath.Separator))
}

// rejectPathSymlinks checks every existing component, including ancestors of
// a not-yet-created leaf. This prevents HOME/.var or an XDG subdirectory from
// redirecting the sandbox state outside the app data tree.
func rejectPathSymlinks(path string) error {
	path, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	volume := filepath.VolumeName(path)
	current := volume + string(filepath.Separator)
	rel := strings.TrimPrefix(path, current)
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("path %q contains symlink %q", path, current)
		}
	}
	return nil
}
