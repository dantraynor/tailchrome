package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestControlURLForPrefsNormalizesDefaultURLs(t *testing.T) {
	for _, raw := range []string{
		"",
		" https://controlplane.tailscale.com ",
		"https://controlplane.tailscale.com/",
		"https://controlplane.tailscale.com:443",
		"https://login.tailscale.com",
		"https://login.tailscale.com/",
		"https://login.tailscale.com:443",
	} {
		t.Run(raw, func(t *testing.T) {
			if got := controlURLForPrefs(raw); got != "" {
				t.Fatalf("controlURLForPrefs(%q) = %q, want empty default", raw, got)
			}
		})
	}
}

func TestControlURLCompareKeyTreatsDefaultSynonymsAsEqual(t *testing.T) {
	keys := []string{
		controlURLCompareKey(""),
		controlURLCompareKey("https://controlplane.tailscale.com"),
		controlURLCompareKey("https://login.tailscale.com"),
	}
	for i, key := range keys {
		if key != "" {
			t.Fatalf("key[%d] = %q, want empty default key", i, key)
		}
	}
}

func TestControlURLCompareKeyKeepsCustomURL(t *testing.T) {
	got := controlURLForPrefs(" https://Headscale.example.com ")
	if got != "https://Headscale.example.com" {
		t.Fatalf("controlURLForPrefs custom = %q", got)
	}

	a := controlURLCompareKey("https://Headscale.example.com/")
	b := controlURLCompareKey("https://headscale.example.com")
	if a != b {
		t.Fatalf("custom compare keys differ: %q != %q", a, b)
	}
}

func TestControlURLCompareKeyKeepsIPv6Brackets(t *testing.T) {
	// A non-default port must keep IPv6 brackets so the key stays a well-formed
	// authority and distinct IPv6 URLs don't collapse together.
	key := controlURLCompareKey("https://[2001:db8::1]:8443")
	if !strings.Contains(key, "[2001:db8::1]:8443") {
		t.Fatalf("IPv6 compare key dropped brackets: %q", key)
	}

	// Distinct IPv6 control URLs must produce distinct keys (regression: both
	// previously normalized to the bracket-less "2001:db8::1:8443").
	if same := controlURLCompareKey("https://[2001:db8::1:8443]"); same == key {
		t.Fatalf("distinct IPv6 control URLs collide: %q", key)
	}

	// The same URL is stable across calls.
	if a, b := controlURLCompareKey("https://[2001:db8::1]:8443"), controlURLCompareKey("https://[2001:db8::1]:8443"); a != b {
		t.Fatalf("IPv6 keys unstable: %q != %q", a, b)
	}
}

func TestIsValidControlURL(t *testing.T) {
	for _, raw := range []string{
		"https://headscale.example.com",
		"http://headscale.test:8080",
		"https://[2001:db8::1]:8443",
	} {
		if !isValidControlURL(raw) {
			t.Errorf("isValidControlURL(%q) = false, want true", raw)
		}
	}
	for _, raw := range []string{
		"not a url",
		"ftp://example.com",
		"https://",
		"example.com",
	} {
		if isValidControlURL(raw) {
			t.Errorf("isValidControlURL(%q) = true, want false", raw)
		}
	}
}

func TestSavedControlURLPersistence(t *testing.T) {
	dir := t.TempDir()

	if err := writeSavedControlURL(dir, " https://headscale.example.com "); err != nil {
		t.Fatalf("writeSavedControlURL: %v", err)
	}
	if got := readSavedControlURL(dir); got != "https://headscale.example.com" {
		t.Fatalf("readSavedControlURL = %q, want saved custom URL", got)
	}

	// Default servers and default synonyms are stored as "".
	if err := writeSavedControlURL(dir, "https://login.tailscale.com/"); err != nil {
		t.Fatalf("writeSavedControlURL: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, controlURLStateFile))
	if err != nil {
		t.Fatalf("reading sidecar: %v", err)
	}
	if string(raw) != "" {
		t.Fatalf("sidecar = %q, want empty for default server", raw)
	}
}

func TestReadSavedControlURLUnusableStates(t *testing.T) {
	dir := t.TempDir()
	if got := readSavedControlURL(dir); got != "" {
		t.Fatalf("readSavedControlURL with no saved file = %q, want empty", got)
	}

	for _, raw := range []string{
		"",
		"https://controlplane.tailscale.com",
		"https://login.tailscale.com/",
		"ftp://not-http.example.com",
		"not a url",
	} {
		if err := os.WriteFile(filepath.Join(dir, controlURLStateFile), []byte(raw), 0600); err != nil {
			t.Fatalf("writing %q: %v", raw, err)
		}
		if got := readSavedControlURL(dir); got != "" {
			t.Errorf("readSavedControlURL with saved %q = %q, want empty", raw, got)
		}
	}
}
