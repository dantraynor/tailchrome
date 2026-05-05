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
