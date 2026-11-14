//go:build !linux

package main

import "fmt"

func installFlatpak(b flatpakBrowser, _ string) error {
	return fmt.Errorf("%s Flatpak installation is supported only on Linux", b.Name)
}

func uninstallFlatpak(b flatpakBrowser) error {
	return fmt.Errorf("%s Flatpak installation is supported only on Linux", b.Name)
}
