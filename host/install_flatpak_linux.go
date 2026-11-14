//go:build linux

package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const (
	flatpakOwnedDir        = "tailchrome"
	flatpakHostRel         = "tailchrome/host/tailchrome"
	flatpakReceiptRel      = "tailchrome/install.json"
	flatpakLockRel         = "tailchrome/install.lock"
	flatpakExtensionRel    = "tailchrome/extension"
	flatpakDescription     = "Tailscale Browser Extension Native Messaging Host"
	expectedChromeStoreKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5/m925fPufiafHbegmZwPoowhf4XOlaEKseW/9Q3u47OQ6ALk/hSYqVOjvv2SZSVIVbVJs5CrfmjWqf65Y6Nf3EkkDYHiimLXifO1XekQMQWsp1KZNHR8ymKDyOE/BFFpl2QgQgfwvNLUYZv6z9+lS95UBZk4rkpm3qS3yFuMaShdURljE/DyrmelRQDCy8YJsoj2yyf4qkap3DCw5k2z5nRGxmw71E4JwavlKySIH5C+wCMo/EoHkjrS/uupbpTxvfTIuXYmmPhx3yyCwBazNrkNjNe5NQk1cLvUkrGvnzo8PO2Zx3Qh9qRZUtdMZ7p1xDzUZi37uePw6QT1xjKwQIDAQAB"
)

type flatpakInstallReceipt struct {
	Version         int    `json:"version"`
	HostPath        string `json:"hostPath"`
	ManifestPath    string `json:"manifestPath"`
	HostSHA256      string `json:"hostSHA256"`
	ManifestSHA256  string `json:"manifestSHA256"`
	ExtensionPath   string `json:"extensionPath,omitempty"`
	ExtensionSHA256 string `json:"extensionSHA256,omitempty"`
}

// These seams make activation and process-state failures testable without
// weakening the production containment and locking implementation.
var flatpakRename = func(root *os.Root, oldPath, newPath string) error { return root.Rename(oldPath, newPath) }
var flatpakRemoveAll = func(root *os.Root, path string) error { return root.RemoveAll(path) }
var flatpakBrowserActive = detectFlatpakActive

func installFlatpak(b flatpakBrowser, extensionDir string) error {
	if os.Getenv("FLATPAK_ID") != "" {
		return fmt.Errorf("%s Flatpak install must be run outside any Flatpak sandbox; FLATPAK_ID=%q", b.Name, os.Getenv("FLATPAK_ID"))
	}
	if extensionDir != "" && !b.SupportsExtensionDir {
		return fmt.Errorf("%s Flatpak does not support --extension-dir", b.Name)
	}
	appDir := flatpakAppDirForCurrentUser(b)
	root, err := openFlatpakRoot(b, appDir)
	if err != nil {
		return err
	}
	defer root.Close()
	release, err := acquireFlatpakLock(root)
	if err != nil {
		return err
	}
	defer release()
	if err := requireFlatpakInactive(b, "changing"); err != nil {
		return err
	}

	source, err := validateInvokingBinaryPath("")
	if err != nil {
		return fmt.Errorf("cannot stage helper for %s Flatpak: %w", b.Name, err)
	}
	if extensionDir != "" {
		if err := validateFlatpakExtensionDir(extensionDir); err != nil {
			return err
		}
	}

	oldReceipt, receiptExists, err := readFlatpakReceipt(root)
	if err != nil {
		return err
	}
	if err := checkFlatpakInstallOwnership(root, b, oldReceipt, receiptExists, extensionDir != ""); err != nil {
		return err
	}

	stageRel := filepath.ToSlash(filepath.Join(flatpakOwnedDir, fmt.Sprintf(".staging-%d", time.Now().UnixNano())))
	backupRel := filepath.ToSlash(filepath.Join(flatpakOwnedDir, fmt.Sprintf(".backup-%d", time.Now().UnixNano())))
	if err := root.MkdirAll(stageRel, 0700); err != nil {
		return fmt.Errorf("create Flatpak staging directory: %w", err)
	}
	defer func() { _ = flatpakRemoveAll(root, stageRel) }()
	if err := root.MkdirAll(backupRel, 0700); err != nil {
		return fmt.Errorf("create Flatpak backup directory: %w", err)
	}

	hostStage := filepath.ToSlash(filepath.Join(stageRel, "host", "tailchrome"))
	if err := copyFlatpakFile(root, source, hostStage, mustExecutableMode(source)); err != nil {
		return fmt.Errorf("stage Flatpak helper: %w", err)
	}
	hostHash, err := hashFlatpakFile(root, hostStage)
	if err != nil {
		return fmt.Errorf("hash staged Flatpak helper: %w", err)
	}

	var extensionHash string
	if extensionDir != "" {
		extStage := filepath.ToSlash(filepath.Join(stageRel, "extension"))
		if err := copyFlatpakTree(root, extensionDir, extStage); err != nil {
			return fmt.Errorf("stage unpacked Chrome extension: %w", err)
		}
		extensionHash, err = hashFlatpakTree(root, extStage)
		if err != nil {
			return fmt.Errorf("hash staged Chrome extension: %w", err)
		}
	}

	manifest := flatpakNativeManifest(b, filepath.Join(appDir, filepath.FromSlash(flatpakHostRel)))
	manifestData, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal Flatpak manifest: %w", err)
	}
	manifestStage := filepath.ToSlash(filepath.Join(stageRel, "manifest.json"))
	if err := writeFlatpakStagedFile(root, manifestStage, append(manifestData, '\n'), 0600); err != nil {
		return fmt.Errorf("stage Flatpak manifest: %w", err)
	}
	manifestHash := sha256Hex(append(manifestData, '\n'))

	receipt := flatpakInstallReceipt{
		Version:        1,
		HostPath:       flatpakHostRel,
		ManifestPath:   b.ManifestRel,
		HostSHA256:     hostHash,
		ManifestSHA256: manifestHash,
	}
	if extensionDir != "" {
		receipt.ExtensionPath = flatpakExtensionRel
		receipt.ExtensionSHA256 = extensionHash
	} else if oldReceipt.ExtensionPath != "" {
		// A store-extension install does not touch an existing unpacked bundle,
		// but retains its ownership metadata so it cannot become orphaned.
		receipt.ExtensionPath = oldReceipt.ExtensionPath
		receipt.ExtensionSHA256 = oldReceipt.ExtensionSHA256
	}
	receiptData, err := json.MarshalIndent(receipt, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal Flatpak install receipt: %w", err)
	}
	receiptStage := filepath.ToSlash(filepath.Join(stageRel, "install.json"))
	if err := writeFlatpakStagedFile(root, receiptStage, append(receiptData, '\n'), 0600); err != nil {
		return fmt.Errorf("stage Flatpak install receipt: %w", err)
	}

	for _, rel := range []string{flatpakHostRel, b.ManifestRel, flatpakReceiptRel, flatpakExtensionRel} {
		if err := rejectUnsafeFlatpakPath(root, rel, false); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	for _, rel := range []string{filepath.Dir(flatpakHostRel), filepath.Dir(b.ManifestRel), filepath.Dir(flatpakReceiptRel)} {
		if err := ensureFlatpakDir(root, filepath.ToSlash(rel)); err != nil {
			return err
		}
	}

	artifacts := []flatpakArtifact{
		{target: flatpakHostRel, stage: hostStage},
	}
	if extensionDir != "" {
		artifacts = append(artifacts, flatpakArtifact{target: flatpakExtensionRel, stage: filepath.ToSlash(filepath.Join(stageRel, "extension"))})
	}
	artifacts = append(artifacts,
		flatpakArtifact{target: b.ManifestRel, stage: manifestStage},
		flatpakArtifact{target: flatpakReceiptRel, stage: receiptStage},
	)
	if err := activateFlatpakArtifacts(root, appDir, artifacts, backupRel); err != nil {
		return err
	}
	if err := flatpakRemoveAll(root, backupRel); err != nil {
		return fmt.Errorf("Flatpak install succeeded but could not remove backup %q: %w", filepath.Join(appDir, filepath.FromSlash(backupRel)), err)
	}
	return nil
}

func uninstallFlatpak(b flatpakBrowser) error {
	if os.Getenv("FLATPAK_ID") != "" {
		return fmt.Errorf("%s Flatpak uninstall must be run outside any Flatpak sandbox; FLATPAK_ID=%q", b.Name, os.Getenv("FLATPAK_ID"))
	}
	appDir := flatpakAppDirForCurrentUser(b)
	root, err := openFlatpakRoot(b, appDir)
	if err != nil {
		return err
	}
	defer root.Close()
	release, err := acquireFlatpakLock(root)
	if err != nil {
		return err
	}
	defer release()
	if err := requireFlatpakInactive(b, "removing"); err != nil {
		return err
	}
	receipt, exists, err := readFlatpakReceipt(root)
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	if err := validateFlatpakReceipt(b, receipt); err != nil {
		return err
	}

	// A modified artifact may no longer be ours. Preserve it and remove only
	// unchanged owned artifacts; this is especially important for an unpacked
	// extension directory that a developer may have edited.
	for _, artifact := range []struct {
		path string
		hash string
		kind string
	}{
		{flatpakHostRel, receipt.HostSHA256, "helper"},
		{b.ManifestRel, receipt.ManifestSHA256, "manifest"},
	} {
		if err := removeOwnedFlatpakFile(root, artifact.path, artifact.hash, artifact.kind); err != nil {
			return err
		}
	}
	if receipt.ExtensionPath != "" {
		hash, hashErr := hashFlatpakTree(root, receipt.ExtensionPath)
		if hashErr == nil && hash == receipt.ExtensionSHA256 {
			if err := flatpakRemoveAll(root, receipt.ExtensionPath); err != nil && !os.IsNotExist(err) {
				return fmt.Errorf("remove owned unpacked extension: %w", err)
			}
		}
	}
	if err := root.Remove(flatpakReceiptRel); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove Flatpak install receipt: %w", err)
	}
	return nil
}

// flatpakNativeManifest builds the browser-specific manifest that points the
// sandboxed browser at the staged helper. Only the stable store/AMO extension
// IDs are allowed, matching the receipt validation on upgrade and removal.
func flatpakNativeManifest(b flatpakBrowser, hostPath string) nativeManifest {
	manifest := nativeManifest{
		Description: flatpakDescription,
		Path:        hostPath,
		Type:        "stdio",
	}
	if b.AppID == firefoxFlatpakID {
		manifest.Name = manifestNameFirefox
		manifest.AllowedExtensions = []string{firefoxExtensionID}
	} else {
		manifest.Name = manifestNameChrome
		manifest.AllowedOrigins = []string{"chrome-extension://" + chromeWebStoreExtensionID + "/"}
	}
	return manifest
}

func requireFlatpakInactive(b flatpakBrowser, action string) error {
	active, err := flatpakBrowserActive(b.AppID)
	if err != nil {
		return fmt.Errorf("cannot determine whether %s Flatpak is active; close %s and ensure the Flatpak command is available: %w", b.Name, b.Name, err)
	}
	if active {
		return fmt.Errorf("%s Flatpak is active; fully close %s and retry before %s its native host", b.Name, b.Name, action)
	}
	return nil
}

type flatpakArtifact struct{ target, stage string }

func activateFlatpakArtifacts(root *os.Root, appDir string, artifacts []flatpakArtifact, backupRel string) error {
	var moved []flatpakArtifact
	for _, artifact := range artifacts {
		backup := filepath.ToSlash(filepath.Join(backupRel, artifact.target))
		if err := ensureFlatpakDir(root, filepath.ToSlash(filepath.Dir(backup))); err != nil {
			return rollbackFlatpakArtifacts(root, appDir, moved, backupRel, err, nil)
		}
		exists, err := flatpakPathExists(root, artifact.target)
		if err != nil {
			return rollbackFlatpakArtifacts(root, appDir, moved, backupRel, err, nil)
		}
		if exists {
			if err := flatpakRename(root, artifact.target, backup); err != nil {
				return rollbackFlatpakArtifacts(root, appDir, moved, backupRel, fmt.Errorf("backup %q: %w", artifact.target, err), nil)
			}
		}
		if err := flatpakRename(root, artifact.stage, artifact.target); err != nil {
			if exists {
				if restoreErr := flatpakRename(root, backup, artifact.target); restoreErr != nil {
					return rollbackFlatpakArtifacts(root, appDir, moved, backupRel, fmt.Errorf("activate %q: %w", artifact.target, err), fmt.Errorf("restore current %q: %w", artifact.target, restoreErr))
				}
			}
			return rollbackFlatpakArtifacts(root, appDir, moved, backupRel, fmt.Errorf("activate %q: %w", artifact.target, err), nil)
		}
		moved = append(moved, flatpakArtifact{target: artifact.target, stage: backup})
	}
	return nil
}

func rollbackFlatpakArtifacts(root *os.Root, appDir string, moved []flatpakArtifact, backupRel string, cause, initialRollbackErr error) error {
	rollbackErr := initialRollbackErr
	for i := len(moved) - 1; i >= 0; i-- {
		artifact := moved[i]
		if err := flatpakRemoveAll(root, artifact.target); err != nil && !os.IsNotExist(err) {
			rollbackErr = errors.Join(rollbackErr, fmt.Errorf("rollback remove %q: %w", artifact.target, err))
			continue
		}
		exists, err := flatpakPathExists(root, artifact.stage)
		if err != nil {
			rollbackErr = errors.Join(rollbackErr, fmt.Errorf("rollback inspect %q: %w", artifact.target, err))
			continue
		}
		if exists {
			if err := flatpakRename(root, artifact.stage, artifact.target); err != nil {
				rollbackErr = errors.Join(rollbackErr, fmt.Errorf("rollback restore %q: %w", artifact.target, err))
			}
		}
	}
	if rollbackErr != nil {
		return errors.Join(cause, fmt.Errorf("rollback failed; backups retained under %q: %w", filepath.ToSlash(filepath.Join(appDir, backupRel)), rollbackErr))
	}
	if err := flatpakRemoveAll(root, backupRel); err != nil {
		rollbackErr = errors.Join(rollbackErr, fmt.Errorf("rollback cleanup: %w", err))
	}
	if rollbackErr != nil {
		return errors.Join(cause, fmt.Errorf("rollback failed; backups retained under %q: %w", filepath.ToSlash(filepath.Join(appDir, backupRel)), rollbackErr))
	}
	return cause
}

func checkFlatpakInstallOwnership(root *os.Root, b flatpakBrowser, receipt flatpakInstallReceipt, receiptExists, wantsExtension bool) error {
	if receiptExists {
		if err := validateFlatpakReceipt(b, receipt); err != nil {
			return err
		}
		for _, artifact := range []struct {
			path string
			hash string
			kind string
		}{
			{flatpakHostRel, receipt.HostSHA256, "helper"},
			{b.ManifestRel, receipt.ManifestSHA256, "manifest"},
		} {
			if err := verifyUnchangedFlatpakArtifact(root, b, artifact.path, artifact.hash, artifact.kind); err != nil {
				return err
			}
		}
		if wantsExtension && receipt.ExtensionPath == "" {
			if exists, _ := flatpakPathExists(root, flatpakExtensionRel); exists {
				return errors.New("unpacked extension path exists but is not owned by Tailchrome; remove it or use a different app directory")
			}
		} else if wantsExtension {
			if err := verifyUnchangedFlatpakArtifact(root, b, receipt.ExtensionPath, receipt.ExtensionSHA256, "unpacked extension"); err != nil {
				return err
			}
		}
		return nil
	}
	for _, path := range []string{flatpakHostRel, b.ManifestRel, flatpakReceiptRel} {
		exists, err := flatpakPathExists(root, path)
		if err != nil {
			return err
		}
		if exists {
			return fmt.Errorf("%s Flatpak path %q already exists without a Tailchrome ownership receipt; refusing to overwrite it", b.Name, path)
		}
	}
	if exists, err := flatpakPathExists(root, flatpakExtensionRel); err != nil {
		return err
	} else if exists && wantsExtension {
		return errors.New("unpacked extension path already exists without a Tailchrome ownership receipt; refusing to overwrite it")
	}
	return nil
}

func verifyUnchangedFlatpakArtifact(root *os.Root, b flatpakBrowser, path, expectedHash, kind string) error {
	exists, err := flatpakPathExists(root, path)
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	var actual string
	if kind == "unpacked extension" {
		actual, err = hashFlatpakTree(root, path)
	} else {
		actual, err = hashFlatpakFile(root, path)
	}
	if err != nil {
		return fmt.Errorf("inspect owned %s Flatpak %s: %w", b.Name, kind, err)
	}
	if actual != expectedHash {
		return fmt.Errorf("%s Flatpak %s was modified outside Tailchrome; refusing to overwrite it", b.Name, kind)
	}
	return nil
}

func validateFlatpakReceipt(b flatpakBrowser, receipt flatpakInstallReceipt) error {
	if receipt.Version != 1 || receipt.HostPath != flatpakHostRel || receipt.ManifestPath != b.ManifestRel {
		return fmt.Errorf("invalid %s Flatpak ownership receipt", b.Name)
	}
	if receipt.HostSHA256 == "" || receipt.ManifestSHA256 == "" {
		return fmt.Errorf("invalid %s Flatpak ownership receipt: missing artifact hashes", b.Name)
	}
	if receipt.ExtensionPath != "" && (!b.SupportsExtensionDir || receipt.ExtensionPath != flatpakExtensionRel || receipt.ExtensionSHA256 == "") {
		return fmt.Errorf("invalid %s Flatpak ownership receipt: invalid extension ownership", b.Name)
	}
	return nil
}

func readFlatpakReceipt(root *os.Root) (flatpakInstallReceipt, bool, error) {
	if err := rejectUnsafeFlatpakPath(root, flatpakReceiptRel, false); err != nil && !errors.Is(err, os.ErrNotExist) {
		return flatpakInstallReceipt{}, false, err
	}
	info, err := root.Lstat(flatpakReceiptRel)
	if os.IsNotExist(err) {
		return flatpakInstallReceipt{}, false, nil
	}
	if err != nil {
		return flatpakInstallReceipt{}, false, fmt.Errorf("inspect Flatpak ownership receipt: %w", err)
	}
	if !info.Mode().IsRegular() {
		return flatpakInstallReceipt{}, false, errors.New("invalid Flatpak ownership receipt: receipt is not a regular file")
	}
	data, err := root.ReadFile(flatpakReceiptRel)
	if os.IsNotExist(err) {
		return flatpakInstallReceipt{}, false, nil
	}
	if err != nil {
		return flatpakInstallReceipt{}, false, fmt.Errorf("read Flatpak ownership receipt: %w", err)
	}
	var receipt flatpakInstallReceipt
	if err := json.Unmarshal(data, &receipt); err != nil {
		return flatpakInstallReceipt{}, false, fmt.Errorf("read Flatpak ownership receipt: %w", err)
	}
	return receipt, true, nil
}

func removeOwnedFlatpakFile(root *os.Root, path, expectedHash, kind string) error {
	hash, err := hashFlatpakFile(root, path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect Flatpak %s: %w", kind, err)
	}
	if hash != expectedHash {
		return nil
	}
	if err := root.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove owned Flatpak %s: %w", kind, err)
	}
	return nil
}

func openFlatpakRoot(b flatpakBrowser, appDir string) (*os.Root, error) {
	if err := rejectPathSymlinks(appDir); err != nil {
		return nil, fmt.Errorf("inspect %s Flatpak app directory %q: %w", b.Name, appDir, err)
	}
	info, err := os.Lstat(appDir)
	if os.IsNotExist(err) {
		return nil, fmt.Errorf("%s Flatpak app directory %q does not exist; launch %s once, then retry", b.Name, appDir, b.AppID)
	}
	if err != nil {
		return nil, fmt.Errorf("inspect %s Flatpak app directory %q: %w", b.Name, appDir, err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, fmt.Errorf("%s Flatpak app directory %q is not a real directory", b.Name, appDir)
	}
	root, err := os.OpenRoot(appDir)
	if err != nil {
		return nil, fmt.Errorf("open %s Flatpak app directory: %w", b.Name, err)
	}
	if err := ensureFlatpakDir(root, flatpakOwnedDir); err != nil {
		root.Close()
		return nil, err
	}
	return root, nil
}

func acquireFlatpakLock(root *os.Root) (func(), error) {
	if err := rejectUnsafeFlatpakPath(root, flatpakLockRel, false); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	f, err := root.OpenFile(flatpakLockRel, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("open Flatpak install lock: %w", err)
	}
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
			return nil, errors.New("another Flatpak install is in progress; wait for it to finish and retry")
		}
		return nil, fmt.Errorf("lock Flatpak app directory: %w", err)
	}
	return func() {
		_ = unix.Flock(int(f.Fd()), unix.LOCK_UN)
		_ = f.Close()
	}, nil
}

func flatpakPathExists(root *os.Root, rel string) (bool, error) {
	if err := rejectUnsafeFlatpakPath(root, rel, false); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func rejectUnsafeFlatpakPath(root *os.Root, rel string, finalDir bool) error {
	rel = filepath.ToSlash(filepath.Clean(rel))
	if rel == "." || strings.HasPrefix(rel, "/") || strings.HasPrefix(rel, "../") || rel == ".." {
		return errors.New("unsafe path outside Flatpak app directory")
	}
	parts := strings.Split(rel, "/")
	for i, part := range parts {
		current := strings.Join(parts[:i+1], "/")
		info, err := root.Lstat(current)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("unsafe Flatpak path %q: symlinks are not allowed", rel)
		}
		if i < len(parts)-1 && !info.IsDir() {
			return fmt.Errorf("unsafe Flatpak path %q: %q is not a directory", rel, part)
		}
	}
	if finalDir {
		info, err := root.Lstat(rel)
		return errOrType(info, err, true)
	}
	return nil
}

func errOrType(info os.FileInfo, err error, wantDir bool) error {
	if err != nil {
		return err
	}
	if wantDir && !info.IsDir() {
		return errors.New("path is not a directory")
	}
	return nil
}

func ensureFlatpakDir(root *os.Root, rel string) error {
	if err := rejectUnsafeFlatpakPath(root, rel, false); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := root.MkdirAll(rel, 0700); err != nil {
		return fmt.Errorf("create Flatpak directory %q: %w", rel, err)
	}
	return rejectUnsafeFlatpakPath(root, rel, true)
}

func copyFlatpakFile(root *os.Root, source, dest string, perm os.FileMode) error {
	if err := rejectSymlinkPath(source); err != nil {
		return err
	}
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&0111 == 0 {
		return fmt.Errorf("source helper %q is not an executable regular file", source)
	}
	if err := ensureFlatpakDir(root, filepath.ToSlash(filepath.Dir(dest))); err != nil {
		return err
	}
	src, err := os.Open(source)
	if err != nil {
		return err
	}
	defer src.Close()
	return writeFlatpakStagedReader(root, dest, src, perm)
}

func copyFlatpakTree(root *os.Root, source, dest string) error {
	if err := rejectSymlinkPath(source); err != nil {
		return err
	}
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("extension directory %q is not a real directory", source)
	}
	if err := ensureFlatpakDir(root, dest); err != nil {
		return err
	}
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("extension bundle contains symlink %q", path)
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		target := filepath.ToSlash(filepath.Join(dest, rel))
		if entry.IsDir() {
			return ensureFlatpakDir(root, target)
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("extension bundle contains unsupported file %q", path)
		}
		fileInfo, err := entry.Info()
		if err != nil {
			return err
		}
		src, err := os.Open(path)
		if err != nil {
			return err
		}
		err = writeFlatpakStagedReader(root, target, src, fileInfo.Mode().Perm())
		closeErr := src.Close()
		if err == nil {
			err = closeErr
		}
		return err
	})
}

func writeFlatpakStagedReader(root *os.Root, rel string, src io.Reader, perm os.FileMode) error {
	file, err := root.OpenFile(rel, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(file, src); err != nil {
		_ = file.Close()
		_ = root.Remove(rel)
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = root.Remove(rel)
		return err
	}
	return file.Close()
}

func writeFlatpakStagedFile(root *os.Root, rel string, data []byte, perm os.FileMode) error {
	return writeFlatpakStagedReader(root, rel, strings.NewReader(string(data)), perm)
}

func hashFlatpakFile(root *os.Root, rel string) (string, error) {
	info, err := root.Lstat(rel)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("%q is not a regular file", rel)
	}
	f, err := root.Open(rel)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	_, err = io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil)), err
}

func hashFlatpakTree(root *os.Root, rel string) (string, error) {
	info, err := root.Lstat(rel)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("%q is not a real directory", rel)
	}
	h := sha256.New()
	err = fs.WalkDir(root.FS(), rel, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink in owned extension tree: %q", path)
		}
		if path == rel {
			return nil
		}
		if entry.IsDir() {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			relPath := strings.TrimPrefix(path, rel+"/")
			_, _ = io.WriteString(h, relPath+"/\x00"+fmt.Sprintf("%o", info.Mode().Perm())+"\x00")
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("special file in owned extension tree: %q", path)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relPath := strings.TrimPrefix(path, rel+"/")
		_, _ = io.WriteString(h, relPath+"\x00"+fmt.Sprintf("%o", info.Mode().Perm())+"\x00")
		f, err := root.Open(path)
		if err != nil {
			return err
		}
		_, err = io.Copy(h, f)
		closeErr := f.Close()
		if err == nil {
			err = closeErr
		}
		return err
	})
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func validateFlatpakExtensionDir(dir string) error {
	if !filepath.IsAbs(dir) {
		return fmt.Errorf("extension-dir must be absolute: %q", dir)
	}
	if err := rejectSymlinkPath(dir); err != nil {
		return fmt.Errorf("invalid unpacked extension: %w", err)
	}
	manifestPath := filepath.Join(dir, "manifest.json")
	if err := rejectSymlinkPath(manifestPath); err != nil {
		return fmt.Errorf("invalid unpacked extension: %w", err)
	}
	manifestInfo, err := os.Lstat(manifestPath)
	if err != nil {
		return fmt.Errorf("invalid unpacked extension: inspect manifest.json: %w", err)
	}
	if !manifestInfo.Mode().IsRegular() {
		return errors.New("invalid unpacked extension: manifest.json must be a regular file")
	}
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("invalid unpacked extension: read manifest.json: %w", err)
	}
	var manifest struct {
		ManifestVersion int      `json:"manifest_version"`
		Key             string   `json:"key"`
		Permissions     []string `json:"permissions"`
		Background      struct {
			ServiceWorker string `json:"service_worker"`
		} `json:"background"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return fmt.Errorf("invalid unpacked extension: manifest.json is not valid JSON: %w", err)
	}
	if manifest.ManifestVersion != 3 {
		return errors.New("invalid unpacked extension: manifest_version must be 3")
	}
	if manifest.Key != expectedChromeStoreKey || chromeExtensionIDForKey(manifest.Key) != chromeWebStoreExtensionID {
		return fmt.Errorf("invalid unpacked extension: manifest key does not identify Tailchrome extension %s", chromeWebStoreExtensionID)
	}
	hasNativeMessaging := false
	for _, permission := range manifest.Permissions {
		if permission == "nativeMessaging" {
			hasNativeMessaging = true
		}
	}
	if !hasNativeMessaging {
		return errors.New("invalid unpacked extension: nativeMessaging permission is required")
	}
	worker := manifest.Background.ServiceWorker
	if worker == "" || filepath.IsAbs(worker) || filepath.Clean(worker) != worker || worker == "." || strings.HasPrefix(filepath.ToSlash(worker), "../") {
		return errors.New("invalid unpacked extension: background.service_worker must be a relative in-bundle path")
	}
	workerInfo, err := os.Lstat(filepath.Join(dir, filepath.FromSlash(worker)))
	if err != nil || !workerInfo.Mode().IsRegular() || workerInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("invalid unpacked extension: background.service_worker is missing or unsafe")
	}
	return nil
}

func chromeExtensionIDForKey(key string) string {
	decoded, err := base64.StdEncoding.DecodeString(key)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(decoded)
	const alphabet = "abcdefghijklmnop"
	var out strings.Builder
	for _, b := range sum[:16] {
		out.WriteByte(alphabet[b>>4])
		out.WriteByte(alphabet[b&0xf])
	}
	return out.String()
}

func rejectSymlinkPath(path string) error {
	return rejectPathSymlinks(path)
}

func mustExecutableMode(path string) os.FileMode {
	info, err := os.Stat(path)
	if err != nil {
		return 0755
	}
	return info.Mode().Perm()
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func flatpakAppDirForCurrentUser(b flatpakBrowser) string {
	home, _ := os.UserHomeDir()
	return flatpakAppDir(home, b)
}

func detectFlatpakActive(appID string) (bool, error) {
	output, err := exec.Command("flatpak", "ps", "--columns=application").CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("flatpak ps failed: %s", strings.TrimSpace(string(output)))
	}
	for _, line := range strings.Split(string(output), "\n") {
		if strings.TrimSpace(line) == appID {
			return true, nil
		}
	}
	return false, nil
}
