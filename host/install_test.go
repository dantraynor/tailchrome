//go:build !windows

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
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
