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
		printChromiumResults(results)
		if err := installFirefox(firefoxExtensionID); err != nil {
			log.Fatalf("Firefox install failed: %v", err)
		}
		fmt.Println("Firefox:  installed.")
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
		printChromiumResults(results)

		fmt.Println("Installing native messaging host for Firefox...")
		if err := installFirefox(firefoxExtensionID); err != nil {
			log.Fatalf("Firefox install failed: %v", err)
		}
		fmt.Println("Firefox:  installed.")

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

// printChromiumResults prints one status line per Chromium-family browser.
// Format: "<Name>: <status>." with column-aligned colons.
func printChromiumResults(results []BrowserInstallResult) {
	for _, r := range results {
		switch {
		case r.Err != nil:
			fmt.Printf("%-9s failed: %v\n", r.Name+":", r.Err)
		case r.ParentExisted:
			fmt.Printf("%-9s installed.\n", r.Name+":")
		default:
			fmt.Printf("%-9s installed (ready for first use).\n", r.Name+":")
		}
	}
}
