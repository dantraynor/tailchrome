package main

import "testing"

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
