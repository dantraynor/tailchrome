package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSanitizeNativeHostEnvironment(t *testing.T) {
	t.Run("clears relative SSL key log path", func(t *testing.T) {
		t.Setenv("SSLKEYLOGFILE", "virtual_file.log")

		sanitizeNativeHostEnvironment()

		if value, ok := os.LookupEnv("SSLKEYLOGFILE"); ok {
			t.Fatalf("SSLKEYLOGFILE still set to %q; want unset", value)
		}
	})

	t.Run("preserves absolute SSL key log path", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "keys.log")
		t.Setenv("SSLKEYLOGFILE", path)

		sanitizeNativeHostEnvironment()

		if got := os.Getenv("SSLKEYLOGFILE"); got != path {
			t.Fatalf("SSLKEYLOGFILE = %q; want %q", got, path)
		}
	})
}
