//go:build linux

package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func flatpakTestSetup(t *testing.T) string {
	t.Helper()
	return flatpakTestSetupFor(t, chromeFlatpak)
}

// flatpakTestSetupFor creates a temp HOME containing only b's app directory
// and stubs the activity probe so no real flatpak command runs.
func flatpakTestSetupFor(t *testing.T, b flatpakBrowser) string {
	t.Helper()
	home := setupTempHome(t)
	t.Setenv("FLATPAK_ID", "")
	app := flatpakAppDir(home, b)
	if err := os.MkdirAll(app, 0755); err != nil {
		t.Fatal(err)
	}
	oldActive := flatpakBrowserActive
	flatpakBrowserActive = func(string) (bool, error) { return false, nil }
	t.Cleanup(func() { flatpakBrowserActive = oldActive })
	return app
}

func TestFirefoxFlatpakInstallWritesGeckoManifestAndUninstalls(t *testing.T) {
	app := flatpakTestSetupFor(t, firefoxFlatpak)
	home := os.Getenv("HOME")
	unrelated := filepath.Join(app, ".mozilla", "native-messaging-hosts", "unrelated.json")
	if err := os.MkdirAll(filepath.Dir(unrelated), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(unrelated, []byte("keep me"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := installFlatpak(firefoxFlatpak, ""); err != nil {
		t.Fatalf("fresh install: %v", err)
	}
	if err := installFlatpak(firefoxFlatpak, ""); err != nil {
		t.Fatalf("repeat install: %v", err)
	}

	hostPath := filepath.Join(app, filepath.FromSlash(flatpakHostRel))
	if info, err := os.Stat(hostPath); err != nil || info.Mode().Perm()&0111 == 0 {
		t.Fatalf("staged helper missing or not executable: %v", err)
	}
	manifestPath := filepath.Join(app, ".mozilla", "native-messaging-hosts", manifestNameFirefox+".json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest nativeManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Name != manifestNameFirefox || manifest.Path != hostPath || manifest.Type != "stdio" ||
		len(manifest.AllowedOrigins) != 0 ||
		len(manifest.AllowedExtensions) != 1 || manifest.AllowedExtensions[0] != firefoxExtensionID {
		t.Fatalf("unexpected Firefox Flatpak manifest: %#v", manifest)
	}
	if _, err := os.Stat(flatpakAppDir(home, chromeFlatpak)); !os.IsNotExist(err) {
		t.Fatalf("Firefox install touched the Chrome app directory: %v", err)
	}

	if err := uninstallFlatpak(firefoxFlatpak); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	for _, path := range []string{hostPath, manifestPath, filepath.Join(app, filepath.FromSlash(flatpakReceiptRel))} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("owned artifact %q remains: %v", path, err)
		}
	}
	if got, err := os.ReadFile(unrelated); err != nil || string(got) != "keep me" {
		t.Errorf("unrelated Firefox file changed: %q, %v", got, err)
	}
}

func TestFirefoxFlatpakRefusesUnownedManifestAndExtensionDir(t *testing.T) {
	app := flatpakTestSetupFor(t, firefoxFlatpak)
	ext := filepath.Join(t.TempDir(), "extension")
	writeValidFlatpakExtension(t, ext, "body")
	if err := installFlatpak(firefoxFlatpak, ext); err == nil || !strings.Contains(err.Error(), "does not support --extension-dir") {
		t.Fatalf("Firefox extension-dir error = %v", err)
	}

	// A manifest copied in by hand (the pre-support workaround) has no
	// receipt and must not be silently replaced.
	manual := filepath.Join(app, filepath.FromSlash(firefoxFlatpak.ManifestRel))
	if err := os.MkdirAll(filepath.Dir(manual), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manual, []byte(`{"name":"manual"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := installFlatpak(firefoxFlatpak, ""); err == nil || !strings.Contains(err.Error(), "without a Tailchrome ownership receipt") {
		t.Fatalf("unowned manifest error = %v", err)
	}
	if got, err := os.ReadFile(manual); err != nil || string(got) != `{"name":"manual"}` {
		t.Fatalf("unowned manifest was modified: %q, %v", got, err)
	}
}

func TestFlatpakReceiptIsBrowserSpecific(t *testing.T) {
	flatpakTestSetup(t)
	if err := installFlatpak(chromeFlatpak, ""); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(flatpakAppDirForCurrentUser(chromeFlatpak))
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	receipt, exists, err := readFlatpakReceipt(root)
	if err != nil || !exists {
		t.Fatalf("read receipt: exists=%v err=%v", exists, err)
	}
	if err := validateFlatpakReceipt(chromeFlatpak, receipt); err != nil {
		t.Fatalf("Chrome receipt rejected for Chrome: %v", err)
	}
	if err := validateFlatpakReceipt(firefoxFlatpak, receipt); err == nil {
		t.Fatal("Chrome receipt accepted for Firefox")
	}
	receipt.ManifestPath = firefoxFlatpak.ManifestRel
	receipt.ExtensionPath = flatpakExtensionRel
	receipt.ExtensionSHA256 = "abc"
	if err := validateFlatpakReceipt(firefoxFlatpak, receipt); err == nil || !strings.Contains(err.Error(), "extension ownership") {
		t.Fatalf("Firefox receipt with unpacked extension error = %v", err)
	}
}

func TestFirefoxFlatpakStateRoot(t *testing.T) {
	home := setupTempHome(t)
	t.Setenv("FLATPAK_ID", firefoxFlatpakID)
	app := flatpakAppDir(home, firefoxFlatpak)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(app, "config"))
	got, err := hostStateDir(home, "id")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(app, "config", "tailscale-browser-ext", "id"); got != want {
		t.Fatalf("Firefox Flatpak state dir = %q, want %q", got, want)
	}

	// Chrome's app tree is outside Firefox's sandbox and must be rejected.
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(flatpakAppDir(home, chromeFlatpak), "config"))
	if _, err := hostStateDir(home, "id"); err == nil || !strings.Contains(err.Error(), "invalid Firefox Flatpak sandbox state root") {
		t.Fatalf("cross-app state root error = %v", err)
	}

	// Unknown Flatpak apps keep the native location.
	t.Setenv("FLATPAK_ID", "org.example.Other")
	got, err = hostStateDir(home, "id")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(home, ".config", "tailscale-browser-ext", "id"); got != want {
		t.Fatalf("unknown Flatpak state dir = %q, want %q", got, want)
	}
}

func TestFirefoxFlatpakCLIFlags(t *testing.T) {
	cmd, err := parseCommand([]string{"install", "--firefox-flatpak"})
	if err != nil {
		t.Fatal(err)
	}
	if target, ok := cmd.Opts.flatpakTarget(); !ok || target.AppID != firefoxFlatpakID {
		t.Fatalf("install --firefox-flatpak target = %#v, %v", target, ok)
	}
	cmd, err = parseCommand([]string{"uninstall", "--firefox-flatpak"})
	if err != nil {
		t.Fatal(err)
	}
	if target, ok := cmd.Opts.flatpakTarget(); !ok || target.AppID != firefoxFlatpakID {
		t.Fatalf("uninstall --firefox-flatpak target = %#v, %v", target, ok)
	}
	for _, args := range [][]string{
		{"install", "--firefox-flatpak", "--chrome-flatpak"},
		{"uninstall", "--firefox-flatpak", "--chrome-flatpak"},
		{"install", "--firefox-flatpak", "--extension-dir", "/abs/ext"},
		{"install", "--firefox-flatpak", "--firefox-id", "other@example.com"},
		{"install", "--firefox-flatpak", "--browser", "firefox"},
		{"uninstall", "--firefox-flatpak", "--binary-path", "/tmp/helper"},
	} {
		if _, err := parseCommand(args); err == nil {
			t.Errorf("parseCommand(%q) accepted an invalid combination", args)
		}
	}
}

func TestChromeFlatpakFreshRepeatAndUninstallPreserveState(t *testing.T) {
	app := flatpakTestSetup(t)
	nativeState := filepath.Join(os.Getenv("HOME"), ".config", "tailscale-browser-ext", "native", "node.key")
	if err := os.MkdirAll(filepath.Dir(nativeState), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(nativeState, []byte("native identity"), 0600); err != nil {
		t.Fatal(err)
	}
	unrelated := filepath.Join(app, "config", "google-chrome", "NativeMessagingHosts", "unrelated.json")
	if err := os.MkdirAll(filepath.Dir(unrelated), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(unrelated, []byte("keep me"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := installFlatpak(chromeFlatpak, ""); err != nil {
		t.Fatalf("fresh install: %v", err)
	}
	if err := installFlatpak(chromeFlatpak, ""); err != nil {
		t.Fatalf("repeat install: %v", err)
	}

	hostPath := filepath.Join(app, filepath.FromSlash(flatpakHostRel))
	info, err := os.Stat(hostPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0111 == 0 {
		t.Fatalf("staged helper lost executable mode: %v", info.Mode())
	}
	manifestPath := filepath.Join(app, filepath.FromSlash(chromeFlatpak.ManifestRel))
	var manifest nativeManifest
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Path != hostPath || len(manifest.AllowedOrigins) != 1 || manifest.AllowedOrigins[0] != "chrome-extension://"+chromeWebStoreExtensionID+"/" {
		t.Fatalf("unexpected Flatpak manifest: %#v", manifest)
	}
	if _, err := os.Stat(filepath.Join(app, filepath.FromSlash(flatpakExtensionRel))); !os.IsNotExist(err) {
		t.Fatalf("default store install copied an unpacked extension: %v", err)
	}

	if err := uninstallFlatpak(chromeFlatpak); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	for _, path := range []string{hostPath, manifestPath, filepath.Join(app, filepath.FromSlash(flatpakReceiptRel))} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("owned artifact %q remains: %v", path, err)
		}
	}
	if got, err := os.ReadFile(nativeState); err != nil || string(got) != "native identity" {
		t.Errorf("native state changed: %q, %v", got, err)
	}
	if got, err := os.ReadFile(unrelated); err != nil || string(got) != "keep me" {
		t.Errorf("unrelated browser file changed: %q, %v", got, err)
	}
}

func writeValidFlatpakExtension(t *testing.T, dir string, body string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	manifest := map[string]any{
		"manifest_version": 3,
		"name":             "Tailchrome",
		"key":              expectedChromeStoreKey,
		"permissions":      []string{"nativeMessaging"},
		"background":       map[string]string{"service_worker": "background.js"},
	}
	data, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "background.js"), []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestChromeFlatpakUnpackedUpgradeAndUninstallOwnership(t *testing.T) {
	app := flatpakTestSetup(t)
	ext := filepath.Join(t.TempDir(), "extension")
	writeValidFlatpakExtension(t, ext, "v1")
	if err := os.WriteFile(filepath.Join(ext, "obsolete.js"), []byte("obsolete"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := installFlatpak(chromeFlatpak, ext); err != nil {
		t.Fatalf("unpacked install: %v", err)
	}
	if err := os.Remove(filepath.Join(ext, "obsolete.js")); err != nil {
		t.Fatal(err)
	}
	writeValidFlatpakExtension(t, ext, "v2")
	if err := installFlatpak(chromeFlatpak, ext); err != nil {
		t.Fatalf("unpacked upgrade: %v", err)
	}
	installedExt := filepath.Join(app, filepath.FromSlash(flatpakExtensionRel))
	if _, err := os.Stat(filepath.Join(installedExt, "obsolete.js")); !os.IsNotExist(err) {
		t.Fatalf("obsolete extension file survived staged swap: %v", err)
	}
	if err := installFlatpak(chromeFlatpak, ""); err != nil {
		t.Fatalf("store-only reinstall after unpacked install: %v", err)
	}
	var receipt flatpakInstallReceipt
	receiptData, err := os.ReadFile(filepath.Join(app, filepath.FromSlash(flatpakReceiptRel)))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(receiptData, &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.ExtensionPath != flatpakExtensionRel || receipt.ExtensionSHA256 == "" {
		t.Fatalf("store-only reinstall orphaned unpacked ownership metadata: %#v", receipt)
	}

	// A developer-owned addition makes the tree hash differ. Uninstall must
	// preserve that whole tree rather than deleting the unowned file.
	if err := os.WriteFile(filepath.Join(installedExt, "developer-note.txt"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := uninstallFlatpak(chromeFlatpak); err != nil {
		t.Fatalf("unpacked uninstall: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(installedExt, "developer-note.txt")); err != nil || string(got) != "keep" {
		t.Errorf("modified unpacked extension was removed: %q, %v", got, err)
	}
}

func TestChromeFlatpakRejectsInvalidBundlesAndUnsafePaths(t *testing.T) {
	app := flatpakTestSetup(t)
	ext := filepath.Join(t.TempDir(), "extension")
	writeValidFlatpakExtension(t, ext, "body")
	data, err := os.ReadFile(filepath.Join(ext, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), expectedChromeStoreKey, strings.Repeat("A", len(expectedChromeStoreKey)), 1))
	if err := os.WriteFile(filepath.Join(ext, "manifest.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := installFlatpak(chromeFlatpak, ext); err == nil || !strings.Contains(err.Error(), "does not identify Tailchrome") {
		t.Fatalf("invalid bundle key error = %v", err)
	}

	if err := os.Remove(filepath.Join(ext, "manifest.json")); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(filepath.Join(ext, "manifest.json"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateFlatpakExtensionDir(ext); err == nil || !strings.Contains(err.Error(), "regular file") {
		t.Fatalf("FIFO manifest error = %v", err)
	}
	if err := os.Remove(filepath.Join(ext, "manifest.json")); err != nil {
		t.Fatal(err)
	}
	writeValidFlatpakExtension(t, ext, "body")
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(ext, "escape.js")); err != nil {
		t.Fatal(err)
	}
	if err := installFlatpak(chromeFlatpak, ext); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("symlink bundle error = %v", err)
	}

	if err := os.Remove(filepath.Join(ext, "escape.js")); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(filepath.Join(ext, "device"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := installFlatpak(chromeFlatpak, ext); err == nil || !strings.Contains(err.Error(), "unsupported file") {
		t.Fatalf("special file bundle error = %v", err)
	}

	// An app-owned path that is a symlink must never be followed.
	if err := os.Symlink(outside, filepath.Join(app, "tailchrome", "host")); err != nil {
		t.Fatal(err)
	}
	if err := installFlatpak(chromeFlatpak, ""); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("unsafe app path error = %v", err)
	}
}

func TestChromeFlatpakReceiptFIFOIsRejectedBeforeRead(t *testing.T) {
	app := flatpakTestSetup(t)
	if err := installFlatpak(chromeFlatpak, ""); err != nil {
		t.Fatal(err)
	}
	receiptPath := filepath.Join(app, filepath.FromSlash(flatpakReceiptRel))
	if err := os.Remove(receiptPath); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(receiptPath, 0600); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(app)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if _, _, err := readFlatpakReceipt(root); err == nil || !strings.Contains(err.Error(), "regular file") {
		t.Fatalf("FIFO receipt error = %v", err)
	}
}

func TestChromeFlatpakRollbackAndModifiedOwnership(t *testing.T) {
	flatpakTestSetup(t)
	oldRename := flatpakRename
	count := 0
	flatpakRename = func(root *os.Root, oldPath, newPath string) error {
		count++
		if count == 2 {
			return errors.New("injected activation failure")
		}
		return oldRename(root, oldPath, newPath)
	}
	err := installFlatpak(chromeFlatpak, "")
	flatpakRename = oldRename
	if err == nil || !strings.Contains(err.Error(), "activate") {
		t.Fatalf("injected activation error = %v", err)
	}
	app := flatpakAppDirForCurrentUser(chromeFlatpak)
	for _, path := range []string{flatpakHostRel, chromeFlatpak.ManifestRel, flatpakReceiptRel} {
		if _, statErr := os.Stat(filepath.Join(app, filepath.FromSlash(path))); !os.IsNotExist(statErr) {
			t.Errorf("rollback left %q: %v", path, statErr)
		}
	}

	if err := installFlatpak(chromeFlatpak, ""); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app, filepath.FromSlash(flatpakHostRel)), []byte("modified"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := installFlatpak(chromeFlatpak, ""); err == nil || !strings.Contains(err.Error(), "modified outside") {
		t.Fatalf("modified helper was overwritten: %v", err)
	}
}

func TestChromeFlatpakRollbackPreservesBackupWhenCurrentRestoreFails(t *testing.T) {
	flatpakTestSetup(t)
	if err := installFlatpak(chromeFlatpak, ""); err != nil {
		t.Fatal(err)
	}
	oldRename := flatpakRename
	count := 0
	flatpakRename = func(root *os.Root, oldPath, newPath string) error {
		count++
		if count == 2 || count == 3 {
			return errors.New("injected rename failure")
		}
		return oldRename(root, oldPath, newPath)
	}
	err := installFlatpak(chromeFlatpak, "")
	flatpakRename = oldRename
	if err == nil || !strings.Contains(err.Error(), "rollback failed") || !strings.Contains(err.Error(), "backups retained") {
		t.Fatalf("current-artifact rollback error = %v", err)
	}
	backupMatches, globErr := filepath.Glob(filepath.Join(flatpakAppDirForCurrentUser(chromeFlatpak), flatpakOwnedDir, ".backup-*", flatpakOwnedDir, "host", "tailchrome"))
	if globErr != nil || len(backupMatches) == 0 {
		t.Fatalf("current artifact backup was not preserved: matches=%v err=%v", backupMatches, globErr)
	}
	if got, readErr := os.ReadFile(backupMatches[0]); readErr != nil || len(got) == 0 {
		t.Fatalf("preserved helper backup unreadable: %v", readErr)
	}
}

func TestChromeFlatpakLockActiveAndEnvironmentFailures(t *testing.T) {
	app := flatpakTestSetup(t)
	root, err := os.OpenRoot(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := root.MkdirAll(flatpakOwnedDir, 0700); err != nil {
		t.Fatal(err)
	}
	release, err := acquireFlatpakLock(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := installFlatpak(chromeFlatpak, ""); err == nil || !strings.Contains(err.Error(), "install is in progress") {
		t.Fatalf("concurrent install error = %v", err)
	}
	release()
	root.Close()

	oldActive := flatpakBrowserActive
	flatpakBrowserActive = func(string) (bool, error) { return false, errors.New("probe unavailable") }
	if err := installFlatpak(chromeFlatpak, ""); err == nil || !strings.Contains(err.Error(), "cannot determine") {
		t.Fatalf("active probe error = %v", err)
	}
	flatpakBrowserActive = oldActive

	t.Setenv("FLATPAK_ID", "org.example.Other")
	if err := installFlatpak(chromeFlatpak, ""); err == nil || !strings.Contains(err.Error(), "outside any Flatpak") {
		t.Fatalf("sandbox invocation error = %v", err)
	}

	_ = app
}

func TestChromeFlatpakStateRootContainment(t *testing.T) {
	home := setupTempHome(t)
	t.Setenv("FLATPAK_ID", chromeFlatpakID)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "outside-config"))
	if _, err := hostStateDir(home, "id"); err == nil || !strings.Contains(err.Error(), "invalid Chrome Flatpak sandbox state root") {
		t.Fatalf("outside state root error = %v", err)
	}
	app := flatpakAppDir(home, chromeFlatpak)
	if err := os.MkdirAll(filepath.Join(app, "config"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(app, "config"))
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.MkdirAll(outside, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(app, "config", "tailscale-browser-ext")); err != nil {
		t.Fatal(err)
	}
	if _, err := hostStateDir(home, "id"); err == nil || !strings.Contains(err.Error(), "invalid Chrome Flatpak sandbox state root") {
		t.Fatalf("state symlink error = %v", err)
	}
	if err := os.Remove(filepath.Join(app, "config", "tailscale-browser-ext")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(app, "config", "tailscale-browser-ext"), 0700); err != nil {
		t.Fatal(err)
	}
	outsideProfile := filepath.Join(t.TempDir(), "outside-profile")
	if err := os.MkdirAll(filepath.Dir(outsideProfile), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideProfile, filepath.Join(app, "config", "tailscale-browser-ext", "id")); err != nil {
		t.Fatal(err)
	}
	if _, err := hostStateDir(home, "id"); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("profile state symlink error = %v", err)
	}
}

func TestChromeFlatpakHashesAreRootRelative(t *testing.T) {
	rootDir := t.TempDir()
	root, err := os.OpenRoot(rootDir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	for _, rel := range []string{"one/tree", "two/tree"} {
		if err := root.MkdirAll(rel, 0700); err != nil {
			t.Fatal(err)
		}
		if err := root.WriteFile(filepath.ToSlash(filepath.Join(rel, "file")), []byte("same"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	one, err := hashFlatpakTree(root, "one/tree")
	if err != nil {
		t.Fatal(err)
	}
	two, err := hashFlatpakTree(root, "two/tree")
	if err != nil {
		t.Fatal(err)
	}
	if one != two {
		t.Fatalf("tree hash includes root path: %s != %s", one, two)
	}
}

func TestChromeFlatpakCLIFlags(t *testing.T) {
	if _, err := parseCommand([]string{"install", "--chrome-flatpak", "--binary-path", "/tmp/helper"}); err == nil {
		t.Fatal("--binary-path was accepted for Chrome Flatpak")
	}
	if _, err := parseCommand([]string{"install", "--extension-dir", "relative"}); err == nil {
		t.Fatal("extension-dir without chrome-flatpak was accepted")
	}
	cmd, err := parseCommand([]string{"uninstall", "--chrome-flatpak"})
	if err != nil || !cmd.Opts.ChromeFlatpak {
		t.Fatalf("flatpak uninstall parse = %#v, %v", cmd, err)
	}
}
