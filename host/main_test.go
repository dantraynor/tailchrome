package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSanitizeNativeHostEnvironment(t *testing.T) {
	t.Run("clears unusable SSL key log path", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "missing", "virtual_file.log")
		t.Setenv("SSLKEYLOGFILE", path)

		sanitizeNativeHostEnvironment()

		if value, ok := os.LookupEnv("SSLKEYLOGFILE"); ok {
			t.Fatalf("SSLKEYLOGFILE still set to %q; want unset", value)
		}
	})

	t.Run("preserves usable SSL key log path", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "keys.log")
		t.Setenv("SSLKEYLOGFILE", path)

		sanitizeNativeHostEnvironment()

		if got := os.Getenv("SSLKEYLOGFILE"); got != path {
			t.Fatalf("SSLKEYLOGFILE = %q; want %q", got, path)
		}
	})
}
