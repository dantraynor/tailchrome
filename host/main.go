// Package main implements a native messaging host for the Tailscale browser extension.
// It communicates with the browser extension via stdin/stdout using the Chrome native
// messaging protocol (4-byte LE length prefix + JSON payload).
package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	"golang.org/x/term"
	"tailscale.com/hostinfo"
)

var version = "dev"

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)

	installFlag := flag.String("install", "", "install native messaging host manifest; value is C<extensionID> for Chrome or F<extensionID> for Firefox")
	installNowFlag := flag.Bool("install-now", false, "install Chrome and Firefox native messaging manifests for the current user (non-interactive; used by the macOS Helper app)")
	uninstallFlag := flag.Bool("uninstall", false, "uninstall native messaging host manifest")
	versionFlag := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *versionFlag {
		fmt.Println(version)
		os.Exit(0)
	}

	if *installNowFlag {
		results, err := installChromiumFamily(chromeWebStoreExtensionID)
		if err != nil {
			log.Fatalf("Chromium-family install failed: %v", err)
		}
		width := browserNameColWidth(results)
		printChromiumResults(width, results)
		if err := installFirefox(firefoxExtensionID); err != nil {
			log.Fatalf("Firefox install failed: %v", err)
		}
		printBrowserResult(width, "Firefox", true, nil)
		fmt.Println("\nYou can use the Tailchrome extension in your browser.")
		os.Exit(0)
	}

	if *uninstallFlag {
		if err := uninstall(); err != nil {
			log.Fatalf("uninstall failed: %v", err)
		}
		fmt.Println("Native messaging host uninstalled successfully.")
		os.Exit(0)
	}

	if *installFlag != "" {
		if err := install(*installFlag); err != nil {
			log.Fatalf("install failed: %v", err)
		}
		fmt.Println("Native messaging host installed successfully.")
		os.Exit(0)
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
		printBrowserResult(width, "Firefox", true, nil)

		fmt.Printf("\nYou can now close this terminal and use the Tailchrome extension.\n")
		os.Exit(0)
	}

	// Default: run as native messaging host (launched by browser).
	hostinfo.SetApp("tailscale-browser-ext")

	h := newHost(os.Stdin, os.Stdout)

	port, err := h.startProxy()
	if err != nil {
		h.send(Reply{
			Cmd: "procRunning",
			ProcRunning: &ProcRunningReply{
				PID:              os.Getpid(),
				Version:          version,
				Error:            errString(err),
				SupportsNetcheck: false,
				SupportsPingPeer: true,
			},
		})
		log.Fatalf("failed to start proxy: %v", err)
	}

	h.send(Reply{
		Cmd: "procRunning",
		ProcRunning: &ProcRunningReply{
			Port:             port,
			PID:              os.Getpid(),
			Version:          version,
			SupportsNetcheck: false,
			SupportsPingPeer: true,
		},
	})

	h.readMessages()
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
		printBrowserResult(width, r.Name, r.ParentExisted, r.Err)
	}
}
