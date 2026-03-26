package main

import (
	"os"
	"os/exec"
	"path/filepath"
)

func chromeManifestDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "google-chrome", "NativeMessagingHosts")
}

func firefoxManifestDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".mozilla", "native-messaging-hosts")
}

func binaryInstallDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "tailscale", "browser-ext")
}

// platformUninstall performs Linux-specific uninstall steps.
// On Linux there are no additional steps beyond removing manifest files.
func platformUninstall() error {
	return nil
}

func platformPostInstallChrome(_ string) error  { return nil }
func platformPostInstallFirefox(_ string) error { return nil }

// isBrowserInstalled checks whether a browser is present on the system.
func isBrowserInstalled(browser string) bool {
	switch browser {
	case "chrome":
		_, err := exec.LookPath("google-chrome")
		if err != nil {
			_, err = exec.LookPath("google-chrome-stable")
		}
		return err == nil
	case "firefox":
		_, err := exec.LookPath("firefox")
		return err == nil
	}
	return false
}
