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
	uninstallFlag := flag.Bool("uninstall", false, "uninstall native messaging host manifest")
	versionFlag := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *versionFlag {
		fmt.Println(version)
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
	// auto-install for both Chrome and Firefox.
	if term.IsTerminal(int(os.Stdin.Fd())) {
		fmt.Println("Installing native messaging host for Chrome...")
		if err := installChrome(chromeWebStoreExtensionID); err != nil {
			log.Fatalf("Chrome install failed: %v", err)
		}
		fmt.Println("Chrome: installed successfully.")

		fmt.Println("Installing native messaging host for Firefox...")
		if err := installFirefox(firefoxExtensionID); err != nil {
			log.Fatalf("Firefox install failed: %v", err)
		}
		fmt.Println("Firefox: installed successfully.")

		fmt.Println("\nYou can now close this terminal and use the Tailchrome extension in Chrome or Firefox.")
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
				PID:   os.Getpid(),
				Error: errString(err),
			},
		})
		log.Fatalf("failed to start proxy: %v", err)
	}

	h.send(Reply{
		Cmd: "procRunning",
		ProcRunning: &ProcRunningReply{
			Port: port,
			PID:  os.Getpid(),
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
