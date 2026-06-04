package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// This file is compiled only on Windows (the _windows suffix is a GOOS build
// constraint), so the Linux/macOS CI run skips it. It is the only place the
// core issue #84 fix -- updating a host binary while it is running -- is
// verified end-to-end, because the running-executable lock cannot be
// reproduced on other platforms.

func TestReplaceBinaryOverwritesUnlocked(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "tailscale-browser-ext.exe")
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
		t.Errorf("dest content = %q, want %q", got, "NEW")
	}
	// When nothing is locked, the fast path writes in place and leaves no
	// ".old" sibling.
	if _, err := os.Stat(dest + ".old"); !os.IsNotExist(err) {
		t.Errorf("unlocked overwrite should not leave a .old file (stat err=%v)", err)
	}
}

// TestReplaceBinaryRenamesAsideWhenLocked simulates a running executable: the
// destination is held open with a share mode that denies writes but permits
// rename/delete -- exactly how the Windows image loader holds a running .exe.
// A plain overwrite fails with ERROR_SHARING_VIOLATION; replaceBinary must
// still install the new binary by moving the locked one aside.
func TestReplaceBinaryRenamesAsideWhenLocked(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "tailscale-browser-ext.exe")
	if err := os.WriteFile(dest, []byte("OLD"), 0o755); err != nil {
		t.Fatalf("seed dest: %v", err)
	}

	closeLock := lockFileLikeRunningExe(t, dest)
	defer closeLock()

	if err := replaceBinary(dest, strings.NewReader("NEWBINARY"), 0o755); err != nil {
		t.Fatalf("replaceBinary under lock returned error: %v", err)
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read dest: %v", err)
	}
	if string(got) != "NEWBINARY" {
		t.Errorf("dest content = %q, want %q (rename-aside path did not install the new binary)", got, "NEWBINARY")
	}
}

// lockFileLikeRunningExe opens path with GENERIC_READ and a share mode of
// READ|DELETE (no WRITE), mirroring the restriction the loader places on a
// running executable: others may read or rename/delete it, but may not open it
// for writing. Returns a closer for the handle.
func lockFileLikeRunningExe(t *testing.T, path string) func() {
	t.Helper()
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatalf("UTF16PtrFromString: %v", err)
	}
	h, err := windows.CreateFile(
		p,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		t.Fatalf("CreateFile (simulate running-exe lock): %v", err)
	}
	return func() { _ = windows.CloseHandle(h) }
}
