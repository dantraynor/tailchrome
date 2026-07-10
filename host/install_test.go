//go:build !windows

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestChromiumManifestDirsContainsExpectedTargets(t *testing.T) {
	home := setupTempHome(t)
	dirs := chromiumManifestDirs()
	if len(dirs) == 0 {
		t.Fatal("chromiumManifestDirs() returned empty slice")
	}

	var want []chromiumBrowserTarget
	switch runtime.GOOS {
	case "darwin":
		base := filepath.Join(home, "Library", "Application Support")
		want = []chromiumBrowserTarget{
			{Name: "Chrome", Dir: filepath.Join(base, "Google", "Chrome", "NativeMessagingHosts")},
			{Name: "Chrome Beta", Dir: filepath.Join(base, "Google", "Chrome Beta", "NativeMessagingHosts")},
			{Name: "Chrome Canary", Dir: filepath.Join(base, "Google", "Chrome Canary", "NativeMessagingHosts")},
			{Name: "Chrome Dev", Dir: filepath.Join(base, "Google", "Chrome Dev", "NativeMessagingHosts")},
			{Name: "Chromium", Dir: filepath.Join(base, "Chromium", "NativeMessagingHosts")},
			{Name: "Brave", Dir: filepath.Join(base, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts")},
			{Name: "Edge", Dir: filepath.Join(base, "Microsoft Edge", "NativeMessagingHosts")},
			{Name: "Vivaldi", Dir: filepath.Join(base, "Vivaldi", "NativeMessagingHosts")},
			{Name: "Opera", Dir: filepath.Join(base, "com.operasoftware.Opera", "NativeMessagingHosts")},
			{Name: "Arc", Dir: filepath.Join(base, "Arc", "User Data", "NativeMessagingHosts")},
		}
	case "linux":
		cfg := filepath.Join(home, ".config")
		want = []chromiumBrowserTarget{
			{Name: "Chrome", Dir: filepath.Join(cfg, "google-chrome", "NativeMessagingHosts")},
			{Name: "Chrome Beta", Dir: filepath.Join(cfg, "google-chrome-beta", "NativeMessagingHosts")},
			{Name: "Chrome Dev", Dir: filepath.Join(cfg, "google-chrome-unstable", "NativeMessagingHosts")},
			{Name: "Chromium", Dir: filepath.Join(cfg, "chromium", "NativeMessagingHosts")},
			{Name: "Brave", Dir: filepath.Join(cfg, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts")},
			{Name: "Edge", Dir: filepath.Join(cfg, "microsoft-edge", "NativeMessagingHosts")},
			{Name: "Vivaldi", Dir: filepath.Join(cfg, "vivaldi", "NativeMessagingHosts")},
			{Name: "Opera", Dir: filepath.Join(cfg, "opera", "NativeMessagingHosts")},
		}
	default:
		t.Skipf("no expected list for GOOS=%s", runtime.GOOS)
	}

	if !reflect.DeepEqual(dirs, want) {
		t.Errorf("chromiumManifestDirs() mismatch\n got: %#v\nwant: %#v", dirs, want)
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

func TestUninstallRemovesInstalledBinary(t *testing.T) {
	setupTempHome(t)

	binPath := installedBinaryPath()
	if err := os.MkdirAll(filepath.Dir(binPath), 0755); err != nil {
		t.Fatalf("failed to create install dir: %v", err)
	}
	if err := os.WriteFile(binPath, []byte("helper"), 0755); err != nil {
		t.Fatalf("failed to stage binary: %v", err)
	}

	if err := uninstall(); err != nil {
		t.Fatalf("uninstall failed: %v", err)
	}

	if _, err := os.Stat(binPath); !os.IsNotExist(err) {
		t.Errorf("post-uninstall: installed binary still exists at %s (err=%v)", binPath, err)
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

func TestReplaceBinaryCreatesWhenAbsent(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "tailscale-browser-ext")
	if err := replaceBinary(dest, strings.NewReader("NEW"), 0o755); err != nil {
		t.Fatalf("replaceBinary returned error: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read dest: %v", err)
	}
	if string(got) != "NEW" {
		t.Errorf("dest content = %q, want %q", got, "NEW")
	}
	info, err := os.Stat(dest)
	if err != nil {
		t.Fatalf("stat dest: %v", err)
	}
	if info.Mode().Perm()&0o100 == 0 {
		t.Errorf("dest is not owner-executable: mode=%v", info.Mode().Perm())
	}
}

func TestReplaceBinaryOverwritesAndTruncates(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "tailscale-browser-ext")
	// Seed with longer content so a non-truncating write would leave a tail.
	if err := os.WriteFile(dest, []byte("OLDOLDOLD"), 0o755); err != nil {
		t.Fatalf("seed dest: %v", err)
	}
	if err := replaceBinary(dest, strings.NewReader("NEW"), 0o755); err != nil {
		t.Fatalf("replaceBinary returned error: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read dest: %v", err)
	}
	if string(got) != "NEW" {
		t.Errorf("dest content = %q, want %q (old content not fully replaced)", got, "NEW")
	}
}

func TestInstallChromiumFamilyParentExistedTrueWhenDirPresent(t *testing.T) {
	setupTempHome(t)
	dirs := chromiumManifestDirs()
	if len(dirs) == 0 {
		t.Skip("no chromium manifest dirs on this platform")
	}
	// Pre-create one browser's parent (config) dir so its result
	// reports ParentExisted=true.
	first := dirs[0]
	if err := os.MkdirAll(filepath.Dir(first.Dir), 0755); err != nil {
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
