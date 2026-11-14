// Package main implements a native messaging host for the Tailscale browser extension.
// It communicates with the browser extension via stdin/stdout using the Chrome native
// messaging protocol (4-byte LE length prefix + JSON payload).
package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"

	"golang.org/x/term"
	// Register Taildrop's LocalAPI and PeerAPI handlers in the embedded node.
	_ "tailscale.com/feature/taildrop"
	"tailscale.com/hostinfo"
)

var version = "dev"

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	cmd, err := parseCommand(os.Args[1:])
	if err != nil {
		log.Fatalf("%v", err)
	}
	if cmd.Kind == commandHelp {
		printUsage()
		return
	}
	if cmd.Kind == commandVersion {
		fmt.Println(version)
		return
	}
	cleanupStaleBinary()

	if cmd.Kind == commandInstall {
		if cmd.Opts.ChromeFlatpak {
			if err := installChromeFlatpak(cmd.Opts.ExtensionDir); err != nil {
				log.Fatalf("Chrome Flatpak install failed: %v", err)
			}
			fmt.Println("Chrome Flatpak native messaging host installed successfully.")
			return
		}
		results, err := installDirectRegistration(cmd.Opts)
		printRegistrationResults(results)
		if err != nil {
			log.Fatalf("install failed: %v", err)
		}
		return
	}

	if cmd.Kind == commandUninstall {
		if cmd.Opts.ChromeFlatpak {
			if err := uninstallChromeFlatpak(); err != nil {
				log.Fatalf("Chrome Flatpak uninstall failed: %v", err)
			}
			fmt.Println("Chrome Flatpak native messaging host uninstalled successfully.")
			return
		}
		binaryPath, err := validateInvokingBinaryPath(cmd.Opts.BinaryPath)
		if err != nil {
			log.Fatalf("uninstall failed: %v", err)
		}
		if err := uninstallOwned(ownerKindDirect, binaryPath, false, cmd.Opts.UserDataDir); err != nil {
			log.Fatalf("uninstall failed: %v", err)
		}
		fmt.Println("Native messaging host uninstalled successfully.")
		return
	}

	if cmd.Kind == commandLegacyInstallNow {
		results, err := installChromiumFamily(chromeWebStoreExtensionID)
		if err != nil {
			log.Fatalf("Chromium-family install failed: %v", err)
		}
		width := browserNameColWidth(results)
		printChromiumResults(width, results)
		if err := installFirefox(firefoxExtensionID); err != nil {
			log.Fatalf("Firefox install failed: %v", err)
		}
		printBrowserInstallResult(width, BrowserInstallResult{Name: "Firefox", ParentExisted: true, ManifestPath: filepath.Join(firefoxManifestDir(), manifestNameFirefox+".json"), RegistryKeys: platformFirefoxRegistryKeys()})
		fmt.Println("\nYou can use the Tailchrome extension in your browser.")
		return
	}

	if cmd.Kind == commandLegacyUninstall {
		if err := uninstall(); err != nil {
			log.Fatalf("uninstall failed: %v", err)
		}
		fmt.Println("Native messaging host uninstalled successfully.")
		return
	}

	if cmd.Kind == commandLegacyInstall {
		if err := install(cmd.Arg); err != nil {
			log.Fatalf("install failed: %v", err)
		}
		fmt.Println("Native messaging host installed successfully.")
		return
	}

	// If running interactively (user ran the binary in a terminal),
	// auto-install for detected browsers.
	if term.IsTerminal(int(os.Stdin.Fd())) {
		fmt.Println("Installing native messaging hosts for the Chromium browser family...")
		results, err := installChromiumFamily(chromeWebStoreExtensionID)
		if err != nil {
			log.Fatalf("Chromium-family install failed: %v", err)
		}
		width := browserNameColWidth(results)
		printChromiumResults(width, results)

		fmt.Println("Installing native messaging host for Firefox...")
		if err := installFirefox(firefoxExtensionID); err != nil {
			log.Fatalf("Firefox install failed: %v", err)
		}
		printBrowserInstallResult(width, BrowserInstallResult{Name: "Firefox", ParentExisted: true, ManifestPath: filepath.Join(firefoxManifestDir(), manifestNameFirefox+".json"), RegistryKeys: platformFirefoxRegistryKeys()})

		fmt.Printf("\nYou can now close this terminal and use the Tailchrome extension.\n")
		os.Exit(0)
	}

	// Default: run as native messaging host (launched by browser).
	sanitizeNativeHostEnvironment()
	hostinfo.SetApp("tailscale-browser-ext")

	h := newHost(os.Stdin, os.Stdout)

	port, err := h.startProxy()
	if err != nil {
		h.send(Reply{
			Cmd: "procRunning",
			ProcRunning: &ProcRunningReply{
				PID:                      os.Getpid(),
				Version:                  version,
				Error:                    errString(err),
				SupportsNetcheck:         false,
				SupportsPingPeer:         true,
				SupportsLogin:            true,
				SupportsCustomControlURL: true,
				SupportsAuthKeyLogin:     true,
			},
		})
		log.Fatalf("failed to start proxy: %v", err)
	}

	h.send(Reply{
		Cmd: "procRunning",
		ProcRunning: &ProcRunningReply{
			Port:                     port,
			ProxyAuth:                h.proxyAuth,
			PID:                      os.Getpid(),
			Version:                  version,
			SupportsNetcheck:         false,
			SupportsPingPeer:         true,
			SupportsLogin:            true,
			SupportsCustomControlURL: true,
			SupportsAuthKeyLogin:     true,
		},
	})

	h.readMessages()
	h.shutdownSession()
}

func printUsage() {
	fmt.Println("Tailchrome native messaging host")
	fmt.Println()
	fmt.Println("Usage:")
	fmt.Println("  tailchrome install [--binary-path PATH] [--browser NAME ...] [--all-browsers]")
	fmt.Println("  tailchrome install --chrome-flatpak [--extension-dir PATH]")
	fmt.Println("  tailchrome uninstall [--binary-path PATH] [--user-data-dir PATH]")
	fmt.Println("  tailchrome uninstall --chrome-flatpak")
	fmt.Println("  tailchrome version")
	fmt.Println()
	fmt.Println("Legacy: -install=C<extensionID>, -install-now, -uninstall, -version")
}

func printRegistrationResults(results []BrowserInstallResult) {
	width := browserNameColWidth(results)
	for _, result := range results {
		printBrowserInstallResult(width, result)
	}
}

func printBrowserInstallResult(width int, result BrowserInstallResult) {
	if result.RolledBack {
		fmt.Printf("%-*s rolled back.\n", width, result.Name+":")
		return
	} else {
		printBrowserResult(width, result.Name, result.ParentExisted, result.Err)
	}
	if result.ManifestPath != "" {
		fmt.Printf("  manifest: %s\n", result.ManifestPath)
	}
	for _, key := range result.RegistryKeys {
		fmt.Printf("  registry: %s\n", key)
	}
}

// sanitizeNativeHostEnvironment removes browser-injected environment values
// that are unusable by a native messaging host. Some security products set
// SSLKEYLOGFILE to a protected virtual path in Firefox child processes, and
// Tailscale's TLS dialer treats failure to open that file as fatal. Probe the
// path with the same access Tailscale requires and preserve it when usable so
// an intentionally configured TLS key log still works.
func sanitizeNativeHostEnvironment() {
	const sslKeyLogFile = "SSLKEYLOGFILE"
	path := os.Getenv(sslKeyLogFile)
	if path == "" {
		return
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		// Stderr reaches the browser's captured helper output, so leave a
		// trace explaining why an expected TLS key log never appears.
		log.Printf("clearing unusable %s %q: %v", sslKeyLogFile, path, err)
		_ = os.Unsetenv(sslKeyLogFile)
		return
	}
	_ = f.Close()
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// browserNameColWidth returns the printf padding width that aligns the
// "<Name>:" column for the given Chromium-family results plus the Firefox
// line, computed at runtime so adding a longer browser name later cannot
// silently break alignment.
func browserNameColWidth(results []BrowserInstallResult) int {
	w := len("Firefox") + 1 // include the trailing colon
	for _, r := range results {
		if n := len(r.Name) + 1; n > w {
			w = n
		}
	}
	return w
}

// printBrowserResult prints one status line for a single browser using the
// shared column width so colons align across the whole install run.
func printBrowserResult(width int, name string, parentExisted bool, err error) {
	nameCol := name + ":"
	switch {
	case err != nil:
		fmt.Printf("%-*s failed: %v\n", width, nameCol, err)
	case parentExisted:
		fmt.Printf("%-*s installed.\n", width, nameCol)
	default:
		fmt.Printf("%-*s installed (ready for first use).\n", width, nameCol)
	}
}

// printChromiumResults prints one status line per Chromium-family browser at
// the given column width.
func printChromiumResults(width int, results []BrowserInstallResult) {
	for _, r := range results {
		printBrowserInstallResult(width, r)
	}
}
