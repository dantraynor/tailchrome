# Chromium-family Native Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the native helper write its native-messaging manifest to every supported Chromium-family browser (Chrome, Chromium, Brave, Edge, Vivaldi, Opera, Arc on macOS) so the extension works in any of them, fixing #66.

**Architecture:** Replace the single `chromeManifestDir()` function in each platform file with a per-platform list of `chromiumBrowserTarget` entries. Refactor `installChrome` into `installChromiumFamily`, which loops over the list, writing the same manifest JSON into every directory and returning a per-browser result slice. `uninstall()` does the inverse. `main.go` prints per-browser status lines.

**Tech Stack:** Go 1.25.5 (host), platform build tags (`install_linux.go`, `install_darwin.go`, `install_windows.go`), standard library `testing` package.

**Spec:** `docs/superpowers/specs/2026-05-05-chromium-family-native-messaging-design.md`

**Build invariant:** Every task ends with a green build on Linux, macOS, and Windows. To enforce this, Task 1 introduces the new abstractions alongside the old ones (both compile); Task 2 swaps callers and removes the old ones in a single atomic change.

---

## File Structure

Files modified:

- `host/install.go` — rename `installChrome` → `installChromiumFamily` (Task 2). Change to loop, return `[]BrowserInstallResult`. Refactor `uninstall()` to loop. Update `install()` arg parser.
- `host/install_linux.go` — add `chromiumManifestDirs()` (Task 1). Add `platformPostInstallChromium` no-op (Task 1). Remove `chromeManifestDir()` and `platformPostInstallChrome` (Task 2).
- `host/install_darwin.go` — same as Linux but with the macOS paths and the Arc entry (Task 1, 2).
- `host/install_windows.go` — add `chromiumManifestDirs()` (Task 1) returning per-browser entries with both the shared on-disk JSON path and the registry key path. Add `platformPostInstallChromium` that creates the right registry key per browser (Task 1). Refactor `platformUninstall` to loop (Task 2). Remove `chromeManifestDir`, `platformPostInstallChrome`, and `ensureWindowsRegistryKeys` (Task 2).
- `host/main.go` — replace `installChrome(...)` calls with `installChromiumFamily(...)`. Drop the `hasChrome`/`hasFirefox` interactive gating (always install both). Print per-browser status lines (Task 3).

Files created:

- `host/install_test.go` — build tag `!windows`. Unit tests for `chromiumManifestDirs()` shape (Task 1), `installChromiumFamily()` writes (Task 2), and `uninstall()` removes + idempotency (Task 2).

Type contracts shared across platforms:

```go
// chromiumBrowserTarget is one Chromium-family browser's native-messaging
// manifest target on this platform.
//
// On Linux/macOS only Name and Dir are meaningful (Path is empty).
// On Windows all three are populated; Dir points at a single shared on-disk
// JSON dir, Path is the per-browser HKCU registry key path.
type chromiumBrowserTarget struct {
    Name string
    Dir  string
    Path string // Windows-only; empty on other platforms
}

// BrowserInstallResult captures per-browser status from installChromiumFamily.
type BrowserInstallResult struct {
    Name           string
    ParentExisted  bool
    Err            error
}
```

The `Path` field is present on every platform's struct (defined identically per platform file) so `install.go` can refer to it conditionally. Linux/macOS leave `Path` empty.

---

## Task 1: Add new per-platform target abstractions alongside old ones

This task adds `chromiumManifestDirs()` and `platformPostInstallChromium` on every platform without removing the old `chromeManifestDir()` or `platformPostInstallChrome` yet. Both old and new exist side by side; the old ones are still wired up to `install.go`. Result: the build stays green on every platform, and Task 2 can swap callers atomically.

**Files:**
- Create: `host/install_test.go`
- Modify: `host/install_linux.go`
- Modify: `host/install_darwin.go`
- Modify: `host/install_windows.go`

- [ ] **Step 1: Write the failing test for `chromiumManifestDirs()`**

Create `host/install_test.go`:

```go
//go:build !windows

package main

import (
	"runtime"
	"strings"
	"testing"
)

func TestChromiumManifestDirsContainsCommonBrowsers(t *testing.T) {
	dirs := chromiumManifestDirs()
	if len(dirs) == 0 {
		t.Fatal("chromiumManifestDirs() returned empty slice")
	}

	wantNames := []string{"Chrome", "Chromium", "Brave", "Edge", "Vivaldi", "Opera"}
	if runtime.GOOS == "darwin" {
		wantNames = append(wantNames, "Arc")
	}

	for _, want := range wantNames {
		found := false
		for _, d := range dirs {
			if d.Name == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("chromiumManifestDirs() missing entry for %q", want)
		}
	}
}

func TestChromiumManifestDirsAllUnderHome(t *testing.T) {
	t.Setenv("HOME", "/tmp/fakehome-tailchrome-test")
	dirs := chromiumManifestDirs()
	for _, d := range dirs {
		if d.Dir == "" {
			t.Errorf("chromiumManifestDirs() entry %q has empty dir", d.Name)
			continue
		}
		if !strings.HasPrefix(d.Dir, "/tmp/fakehome-tailchrome-test") {
			t.Errorf("chromiumManifestDirs() entry %q dir %q is not under HOME", d.Name, d.Dir)
		}
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd host && go test -run TestChromiumManifestDirs -v ./...
```
Expected: build error — `chromiumManifestDirs` undefined.

- [ ] **Step 3: Add `chromiumManifestDirs()` and the new platform hook to `install_linux.go`**

Replace `host/install_linux.go` entirely with:

```go
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

// chromeManifestDir returns the legacy single-browser manifest directory.
// Retained until Task 2 removes the last caller.
func chromeManifestDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "google-chrome", "NativeMessagingHosts")
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

// platformPostInstallChrome is the legacy single-browser hook. Retained until
// Task 2 removes its last caller.
func platformPostInstallChrome(_ string) error  { return nil }

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
```

- [ ] **Step 4: Add `chromiumManifestDirs()` and the new platform hook to `install_darwin.go`**

Replace `host/install_darwin.go` entirely with:

```go
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
```

- [ ] **Step 5: Add `chromiumManifestDirs()` and the new platform hook to `install_windows.go`**

Replace `host/install_windows.go` entirely with:

```go
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
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd host && go test -run TestChromiumManifestDirs -v ./...
```
Expected: PASS — both subtests succeed on the current platform (Linux or macOS).

```bash
cd host && go test ./...
```
Expected: all existing tests still pass.

- [ ] **Step 7: Cross-platform build sweep**

```bash
cd host
GOOS=linux  GOARCH=amd64 CGO_ENABLED=0 go build -o /dev/null .
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -o /dev/null .
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o /dev/null .
```
Expected: all three succeed. Old `chromeManifestDir`/`platformPostInstallChrome` still exist and `install.go` still uses them; new `chromiumManifestDirs`/`platformPostInstallChromium` exist alongside, ready for Task 2.

- [ ] **Step 8: Commit**

```bash
git add host/install_test.go host/install_linux.go host/install_darwin.go host/install_windows.go
git commit -m "host: add chromiumManifestDirs() and platformPostInstallChromium for all platforms"
```

---

## Task 2: Refactor install.go to use new abstractions, remove legacy functions

This is the central behavior change. `installChrome` becomes `installChromiumFamily`, looping over `chromiumManifestDirs()` and returning a per-browser result slice. `uninstall()` loops the same list. The old `chromeManifestDir`/`platformPostInstallChrome`/`ensureWindowsRegistryKeys` functions are removed in this same task because Task 1 introduced their replacements.

**Files:**
- Modify: `host/install.go`
- Modify: `host/install_test.go`
- Modify: `host/install_linux.go`
- Modify: `host/install_darwin.go`
- Modify: `host/install_windows.go`

- [ ] **Step 1: Write the failing tests for `installChromiumFamily` and `uninstall`**

In `host/install_test.go`, replace the existing `import` block with:

```go
import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)
```

Then append these tests (and the helper) at the bottom of the file:

```go
const testExtensionID = "test-extension-id-123"

func setupTempHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", dir)
		t.Setenv("LOCALAPPDATA", filepath.Join(dir, "AppData", "Local"))
	}
	return dir
}

func TestInstallChromiumFamilyWritesManifestPerBrowser(t *testing.T) {
	home := setupTempHome(t)
	results, err := installChromiumFamily(testExtensionID)
	if err != nil {
		t.Fatalf("installChromiumFamily returned error: %v", err)
	}

	dirs := chromiumManifestDirs()
	if len(results) != len(dirs) {
		t.Errorf("expected %d results, got %d", len(dirs), len(results))
	}

	for _, d := range dirs {
		manifestPath := filepath.Join(d.Dir, manifestNameChrome+".json")
		data, err := os.ReadFile(manifestPath)
		if err != nil {
			t.Errorf("manifest for %s missing at %s: %v", d.Name, manifestPath, err)
			continue
		}
		var m nativeManifest
		if err := json.Unmarshal(data, &m); err != nil {
			t.Errorf("manifest for %s not valid JSON: %v", d.Name, err)
			continue
		}
		if m.Name != manifestNameChrome {
			t.Errorf("manifest for %s has wrong Name: %q", d.Name, m.Name)
		}
		if m.Type != "stdio" {
			t.Errorf("manifest for %s has wrong Type: %q", d.Name, m.Type)
		}
		expectedOrigin := "chrome-extension://" + testExtensionID + "/"
		if len(m.AllowedOrigins) != 1 || m.AllowedOrigins[0] != expectedOrigin {
			t.Errorf("manifest for %s has wrong AllowedOrigins: %v", d.Name, m.AllowedOrigins)
		}
		if !strings.HasPrefix(m.Path, home) {
			t.Errorf("manifest for %s has Path outside HOME: %q", d.Name, m.Path)
		}
	}

	for _, r := range results {
		if r.Err != nil {
			t.Errorf("result for %s has error: %v", r.Name, r.Err)
		}
		if r.ParentExisted {
			t.Errorf("result for %s reports ParentExisted=true on a fresh temp HOME", r.Name)
		}
	}
}

func TestUninstallRemovesAllChromiumManifests(t *testing.T) {
	setupTempHome(t)

	if _, err := installChromiumFamily(testExtensionID); err != nil {
		t.Fatalf("install failed: %v", err)
	}

	dirs := chromiumManifestDirs()
	for _, d := range dirs {
		manifestPath := filepath.Join(d.Dir, manifestNameChrome+".json")
		if _, err := os.Stat(manifestPath); err != nil {
			t.Fatalf("pre-uninstall: %s manifest missing at %s: %v", d.Name, manifestPath, err)
		}
	}

	if err := uninstall(); err != nil {
		t.Fatalf("uninstall failed: %v", err)
	}

	for _, d := range dirs {
		manifestPath := filepath.Join(d.Dir, manifestNameChrome+".json")
		if _, err := os.Stat(manifestPath); !os.IsNotExist(err) {
			t.Errorf("post-uninstall: %s manifest still exists at %s (err=%v)", d.Name, manifestPath, err)
		}
	}
}

func TestUninstallIsIdempotent(t *testing.T) {
	setupTempHome(t)
	if err := uninstall(); err != nil {
		t.Fatalf("first uninstall on empty home failed: %v", err)
	}
	if err := uninstall(); err != nil {
		t.Fatalf("second uninstall failed: %v", err)
	}
}

func TestInstallChromiumFamilyParentExistedTrueWhenDirPresent(t *testing.T) {
	setupTempHome(t)
	dirs := chromiumManifestDirs()
	if len(dirs) == 0 {
		t.Skip("no chromium manifest dirs on this platform")
	}
	// Pre-create one parent dir so its result reports ParentExisted=true.
	first := dirs[0]
	if err := os.MkdirAll(first.Dir, 0755); err != nil {
		t.Fatalf("pre-create dir: %v", err)
	}

	results, err := installChromiumFamily(testExtensionID)
	if err != nil {
		t.Fatalf("installChromiumFamily returned error: %v", err)
	}

	for _, r := range results {
		if r.Name == first.Name {
			if !r.ParentExisted {
				t.Errorf("expected ParentExisted=true for %s", r.Name)
			}
		} else {
			if r.ParentExisted {
				t.Errorf("expected ParentExisted=false for %s, got true", r.Name)
			}
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd host && go test -run "TestInstallChromiumFamily|TestUninstall" -v ./...
```
Expected: build error — `installChromiumFamily`, `BrowserInstallResult`, etc. undefined.

- [ ] **Step 3: Replace `host/install.go` entirely**

Write the new `host/install.go`:

```go
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
	results := make([]BrowserInstallResult, 0, len(dirs))
	successes := 0
	for _, target := range dirs {
		r := BrowserInstallResult{Name: target.Name}
		if _, statErr := os.Stat(target.Dir); statErr == nil {
			r.ParentExisted = true
		}
		if err := os.MkdirAll(target.Dir, 0755); err != nil {
			r.Err = fmt.Errorf("create dir: %w", err)
			results = append(results, r)
			continue
		}
		manifestPath := filepath.Join(target.Dir, manifestNameChrome+".json")
		if err := writeManifest(manifestPath, manifest); err != nil {
			r.Err = err
			results = append(results, r)
			continue
		}
		if err := platformPostInstallChromium(target.Name, manifestPath); err != nil {
			r.Err = err
			results = append(results, r)
			continue
		}
		successes++
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
```

The old `installChrome` is gone; `install()` now dispatches `'C'` to `installChromiumFamily`. `uninstall()` now loops over `chromiumManifestDirs()` instead of calling `chromeManifestDir()`.

- [ ] **Step 4: Remove the legacy `chromeManifestDir` and `platformPostInstallChrome` from each platform file**

In `host/install_linux.go`, delete these lines (added in Task 1 with retention comments):

```go
// chromeManifestDir returns the legacy single-browser manifest directory.
// Retained until Task 2 removes the last caller.
func chromeManifestDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "google-chrome", "NativeMessagingHosts")
}
```

and:

```go
// platformPostInstallChrome is the legacy single-browser hook. Retained until
// Task 2 removes its last caller.
func platformPostInstallChrome(_ string) error  { return nil }
```

In `host/install_darwin.go`, delete the equivalent two functions.

In `host/install_windows.go`, delete:

```go
// chromeManifestDir returns the legacy single-browser manifest directory.
// Retained until Task 2 removes the last caller.
func chromeManifestDir() string {
	return chromiumJSONDir()
}
```

and:

```go
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
```

and:

```go
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
```

- [ ] **Step 5: Refactor Windows `platformUninstall` to loop**

Replace the `platformUninstall` function in `host/install_windows.go` with:

```go
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
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd host && go test -run "TestInstallChromiumFamily|TestUninstall|TestChromiumManifestDirs" -v ./...
```
Expected: all PASS.

```bash
cd host && go test ./...
```
Expected: all existing tests still pass.

- [ ] **Step 7: Cross-platform build sweep**

```bash
cd host
GOOS=linux  GOARCH=amd64 CGO_ENABLED=0 go build -o /dev/null .
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -o /dev/null .
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o /dev/null .
```
Expected: all three succeed. Note: `main.go` still calls the old `installChrome` symbol — at this point Task 2 has just renamed it to `installChromiumFamily`, so `main.go` will fail to build until Task 3. Wait — that's a problem. Task 2 must keep `main.go` working.

To keep the build green, **also update `main.go`'s two call sites in this same task** before running the build sweep. The full `main.go` rewrite (output formatting) is still Task 3, but the minimum diff to keep it compiling is needed here:

In `host/main.go`, replace lines 33–34:

```go
		if err := installChrome(chromeWebStoreExtensionID); err != nil {
			log.Fatalf("Chrome install failed: %v", err)
		}
```

with:

```go
		if _, err := installChromiumFamily(chromeWebStoreExtensionID); err != nil {
			log.Fatalf("Chromium-family install failed: %v", err)
		}
```

And replace lines 75–77 (in the interactive `if hasChrome` block):

```go
			if err := installChrome(chromeWebStoreExtensionID); err != nil {
				log.Fatalf("Chrome install failed: %v", err)
			}
```

with:

```go
			if _, err := installChromiumFamily(chromeWebStoreExtensionID); err != nil {
				log.Fatalf("Chromium-family install failed: %v", err)
			}
```

These two minimal edits keep main.go compiling. Task 3 will rewrite the surrounding code to produce per-browser output.

After these edits, re-run the build sweep:

```bash
cd host
GOOS=linux  GOARCH=amd64 CGO_ENABLED=0 go build -o /dev/null .
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -o /dev/null .
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o /dev/null .
```
Expected: all three succeed.

- [ ] **Step 8: Commit**

```bash
git add host/install.go host/install_test.go host/install_linux.go host/install_darwin.go host/install_windows.go host/main.go
git commit -m "host: install native-messaging manifest for all Chromium browsers"
```

---

## Task 3: Rewrite `main.go` install flow with per-browser status output

**Files:**
- Modify: `host/main.go`

- [ ] **Step 1: Replace the `--install-now` block**

In `host/main.go`, replace the current `--install-now` block (lines 32–43, the version after Task 2's minimal edit):

```go
	if *installNowFlag {
		if _, err := installChromiumFamily(chromeWebStoreExtensionID); err != nil {
			log.Fatalf("Chromium-family install failed: %v", err)
		}
		fmt.Println("Chrome: installed successfully.")
		if err := installFirefox(firefoxExtensionID); err != nil {
			log.Fatalf("Firefox install failed: %v", err)
		}
		fmt.Println("Firefox: installed successfully.")
		fmt.Println("\nYou can use the Tailchrome extension in your browser.")
		os.Exit(0)
	}
```

with:

```go
	if *installNowFlag {
		results, err := installChromiumFamily(chromeWebStoreExtensionID)
		if err != nil {
			log.Fatalf("Chromium-family install failed: %v", err)
		}
		printChromiumResults(results)
		if err := installFirefox(firefoxExtensionID); err != nil {
			log.Fatalf("Firefox install failed: %v", err)
		}
		fmt.Println("Firefox:  installed.")
		fmt.Println("\nYou can use the Tailchrome extension in your browser.")
		os.Exit(0)
	}
```

- [ ] **Step 2: Replace the interactive `term.IsTerminal` block**

Replace the entire `if term.IsTerminal(int(os.Stdin.Fd())) { ... }` block (the version after Task 2's minimal edit, currently doing per-flag gating with `hasChrome`/`hasFirefox`):

```go
	if term.IsTerminal(int(os.Stdin.Fd())) {
		hasChrome := isBrowserInstalled("chrome")
		hasFirefox := isBrowserInstalled("firefox")

		if !hasChrome && !hasFirefox {
			hasChrome = true
			hasFirefox = true
		}

		installed := 0
		if hasChrome {
			fmt.Println("Installing native messaging host for Chrome...")
			if _, err := installChromiumFamily(chromeWebStoreExtensionID); err != nil {
				log.Fatalf("Chromium-family install failed: %v", err)
			}
			fmt.Println("Chrome: installed successfully.")
			installed++
		}

		if hasFirefox {
			fmt.Println("Installing native messaging host for Firefox...")
			if err := installFirefox(firefoxExtensionID); err != nil {
				log.Fatalf("Firefox install failed: %v", err)
			}
			fmt.Println("Firefox: installed successfully.")
			installed++
		}

		fmt.Printf("\nYou can now close this terminal and use the Tailchrome extension.\n")
		os.Exit(0)
	}
```

with:

```go
	if term.IsTerminal(int(os.Stdin.Fd())) {
		fmt.Println("Installing native messaging hosts for the Chromium browser family...")
		results, err := installChromiumFamily(chromeWebStoreExtensionID)
		if err != nil {
			log.Fatalf("Chromium-family install failed: %v", err)
		}
		printChromiumResults(results)

		fmt.Println("Installing native messaging host for Firefox...")
		if err := installFirefox(firefoxExtensionID); err != nil {
			log.Fatalf("Firefox install failed: %v", err)
		}
		fmt.Println("Firefox:  installed.")

		fmt.Printf("\nYou can now close this terminal and use the Tailchrome extension.\n")
		os.Exit(0)
	}
```

The `installed`, `hasChrome`, `hasFirefox`, and `isBrowserInstalled` references are gone — the per-browser result slice now communicates everything the user needs.

- [ ] **Step 3: Add the `printChromiumResults` helper at the bottom of `main.go`**

After the existing `errString` function, add:

```go
// printChromiumResults prints one status line per Chromium-family browser.
// Format: "<Name>: <status>." with column-aligned colons.
func printChromiumResults(results []BrowserInstallResult) {
	for _, r := range results {
		switch {
		case r.Err != nil:
			fmt.Printf("%-9s failed: %v\n", r.Name+":", r.Err)
		case r.ParentExisted:
			fmt.Printf("%-9s installed.\n", r.Name+":")
		default:
			fmt.Printf("%-9s installed (ready for first use).\n", r.Name+":")
		}
	}
}
```

The `%-9s` width fits the longest browser name with a trailing colon ("Chromium:" = 9 chars), so all status text starts in column 10. Firefox's lone status line below uses `"Firefox:  "` (Firefox + colon + two padding spaces = 10 chars) for visual consistency.

- [ ] **Step 4: Run a manual smoke install**

Build and run interactively into a temp HOME:

```bash
cd host && go build -o /tmp/tcb .
HOME=$(mktemp -d) /tmp/tcb
```

Expected output on macOS:

```
Installing native messaging hosts for the Chromium browser family...
Chrome:   installed (ready for first use).
Chromium: installed (ready for first use).
Brave:    installed (ready for first use).
Edge:     installed (ready for first use).
Vivaldi:  installed (ready for first use).
Opera:    installed (ready for first use).
Arc:      installed (ready for first use).
Installing native messaging host for Firefox...
Firefox:  installed.

You can now close this terminal and use the Tailchrome extension.
```

If the colons don't line up, adjust the `%-9s` width.

- [ ] **Step 5: Run the full test suite**

```bash
cd host && go test ./...
```
Expected: all tests pass.

- [ ] **Step 6: Cross-platform build sweep**

```bash
cd host
GOOS=linux  GOARCH=amd64 CGO_ENABLED=0 go build -o /dev/null .
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -o /dev/null .
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o /dev/null .
```
Expected: all three succeed.

- [ ] **Step 7: Commit**

```bash
git add host/main.go
git commit -m "host: print per-browser native-messaging install status"
```

---

## Task 4: Final cross-platform verification and manual smoke

**Files:**
- Verification only.

- [ ] **Step 1: Cross-platform build sweep (final)**

```bash
cd host
GOOS=linux  GOARCH=amd64 CGO_ENABLED=0 go build -o /dev/null .
GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build -o /dev/null .
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -o /dev/null .
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o /dev/null .
```
Expected: all four succeed.

- [ ] **Step 2: `go vet` and full test suite**

```bash
cd host && go vet ./... && go test ./...
```
Expected: no vet warnings, all tests pass.

- [ ] **Step 3: Manual smoke on the dev machine (macOS)**

```bash
TMPHOME=$(mktemp -d)
cd host && go build -o /tmp/tcb .
HOME=$TMPHOME /tmp/tcb --install-now
ls -la "$TMPHOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/"
ls -la "$TMPHOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts/"
ls -la "$TMPHOME/Library/Application Support/Arc/User Data/NativeMessagingHosts/"
cat "$TMPHOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.tailscale.browserext.chrome.json"
```

Expected:
- Each `ls` shows `com.tailscale.browserext.chrome.json` present.
- The `cat` output is valid JSON with `"name": "com.tailscale.browserext.chrome"`, `"type": "stdio"`, `"path"` pointing inside `$TMPHOME/Library/Application Support/Tailscale/BrowserExt/`, and `"allowed_origins"` containing `"chrome-extension://bhfeceecialgilpedkoflminjgcjljll/"`.

- [ ] **Step 4: Manual uninstall smoke**

```bash
HOME=$TMPHOME /tmp/tcb --uninstall
ls "$TMPHOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/" 2>&1
ls "$TMPHOME/Library/Application Support/Arc/User Data/NativeMessagingHosts/" 2>&1
```

Expected: each `ls` outputs an empty directory listing (the directories remain but the JSON files are gone). Re-running `--uninstall` succeeds quietly.

- [ ] **Step 5: Final commit if any tweaks were needed**

```bash
git status
```
If clean, no commit. If anything was tweaked during smoke testing, commit with a small follow-up message.

---

## Self-Review Notes

Cross-checked the plan against the spec section by section:

- "Browsers covered" table — every entry maps to a row in `chromiumManifestDirs()` per platform (Task 1 Steps 3, 4, 5).
- "Per-platform manifest-target tables" — Task 1.
- "Cross-platform install loop" — Task 2 (`installChromiumFamily` returns `[]BrowserInstallResult`, aggregates errors via `errors.Join`, "at-least-one-success" rule).
- "CLI flag semantics" (`C` keeps meaning, broadens to whole family) — Task 2 Step 3 updates `install()` arg parser.
- "Output messages" three-state framing (`installed` / `installed (ready for first use)` / `failed`) — captured in `BrowserInstallResult.ParentExisted` and `.Err` (Task 2 Step 3) + rendered by `printChromiumResults` (Task 3 Step 3).
- Uninstall loop + idempotence — Task 2 Step 3 (refactor) + Task 2 Step 1 (test coverage).
- Testing section: `chromiumManifestDirs` shape test (Task 1), `installChromiumFamily` write test (Task 2), uninstall removal + idempotence (Task 2), `ParentExisted` framing test (Task 2).
- "macOS .pkg installer unchanged" — confirmed: Task 3 only changes the on-stdout text the Helper.app produces; the .pkg build pipeline and Helper.app entry point are untouched.

Build invariant check: every task ends with `GOOS=linux/darwin/windows go build` succeeding. Task 2 Step 7 highlights the one place this almost slipped (main.go calls a renamed symbol) and includes the minimal main.go diff alongside the install.go rewrite to keep the build green.

No spec requirement is unimplemented. No placeholders. Type names are consistent across tasks: `chromiumBrowserTarget`, `BrowserInstallResult`, `installChromiumFamily`, `chromiumManifestDirs`, `platformPostInstallChromium`, `printChromiumResults`.
