package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

type commandKind int

const (
	commandNative commandKind = iota
	commandInstall
	commandUninstall
	commandVersion
	commandHelp
	commandLegacyInstall
	commandLegacyInstallNow
	commandLegacyUninstall
)

type parsedCommand struct {
	Kind commandKind
	Opts registrationOptions
	Arg  string
}

type registrationOptions struct {
	BinaryPath     string
	ChromeID       string
	FirefoxID      string
	Browsers       []string
	AllBrowsers    bool
	UserDataDir    string
	ChromeFlatpak  bool
	FirefoxFlatpak bool
	ExtensionDir   string
}

// flatpakTarget returns the Flatpak browser selected by --chrome-flatpak or
// --firefox-flatpak. The parsers reject selecting both.
func (o registrationOptions) flatpakTarget() (flatpakBrowser, bool) {
	switch {
	case o.ChromeFlatpak:
		return chromeFlatpak, true
	case o.FirefoxFlatpak:
		return firefoxFlatpak, true
	}
	return flatpakBrowser{}, false
}

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(value string) error {
	if value == "" {
		return errors.New("browser name must not be empty")
	}
	*s = append(*s, value)
	return nil
}

// parseCommand deliberately treats unrecognized arguments as native-host
// arguments. Browsers may pass arguments when launching a native host; those
// must never be interpreted as helper CLI errors or reach protocol stdout.
func parseCommand(args []string) (parsedCommand, error) {
	if len(args) == 0 {
		return parsedCommand{Kind: commandNative}, nil
	}
	if len(args) == 1 && (args[0] == "help" || args[0] == "-h" || args[0] == "--help") {
		return parsedCommand{Kind: commandHelp}, nil
	}
	switch args[0] {
	case "install":
		if hasHelpArg(args[1:]) {
			return parsedCommand{Kind: commandHelp}, nil
		}
		return parseInstallCommand(args[1:])
	case "uninstall":
		if hasHelpArg(args[1:]) {
			return parsedCommand{Kind: commandHelp}, nil
		}
		return parseUninstallCommand(args[1:])
	case "version":
		if len(args) != 1 {
			return parsedCommand{}, errors.New("version does not accept arguments")
		}
		return parsedCommand{Kind: commandVersion}, nil
	}
	for _, arg := range args {
		switch arg {
		case "-install", "--install", "-install-now", "--install-now", "-uninstall", "--uninstall", "-version", "--version":
			return parseLegacyCommand(args)
		}
		for _, prefix := range []string{"-install=", "--install=", "-version=", "--version=", "-install-now=", "--install-now=", "-uninstall=", "--uninstall="} {
			if strings.HasPrefix(arg, prefix) {
				return parseLegacyCommand(args)
			}
		}
	}
	return parsedCommand{Kind: commandNative}, nil
}

func hasHelpArg(args []string) bool {
	for _, arg := range args {
		if arg == "-h" || arg == "--help" || arg == "help" {
			return true
		}
	}
	return false
}

func parseInstallCommand(args []string) (parsedCommand, error) {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var browsers stringList
	fs.Var(&browsers, "browser", "browser to register (repeatable)")
	opts := registrationOptions{}
	fs.StringVar(&opts.BinaryPath, "binary-path", "", "absolute path to the invoking executable")
	fs.StringVar(&opts.ChromeID, "chrome-id", chromeWebStoreExtensionID, "Chrome extension ID")
	fs.StringVar(&opts.FirefoxID, "firefox-id", firefoxExtensionID, "Firefox extension ID")
	fs.BoolVar(&opts.AllBrowsers, "all-browsers", false, "register every supported browser")
	fs.StringVar(&opts.UserDataDir, "user-data-dir", "", "custom Chromium user-data directory")
	fs.BoolVar(&opts.ChromeFlatpak, "chrome-flatpak", false, "install the helper for Chrome Flatpak")
	fs.BoolVar(&opts.FirefoxFlatpak, "firefox-flatpak", false, "install the helper for Firefox Flatpak")
	fs.StringVar(&opts.ExtensionDir, "extension-dir", "", "unpacked Chromium extension directory for Chrome Flatpak")
	if err := fs.Parse(args); err != nil {
		return parsedCommand{}, err
	}
	if fs.NArg() != 0 {
		return parsedCommand{}, fmt.Errorf("install: unexpected argument %q", fs.Arg(0))
	}
	opts.Browsers = browsers
	if opts.ExtensionDir != "" {
		if !opts.ChromeFlatpak {
			return parsedCommand{}, errors.New("--extension-dir requires --chrome-flatpak")
		}
		if !filepath.IsAbs(opts.ExtensionDir) {
			return parsedCommand{}, fmt.Errorf("extension-dir must be absolute: %q", opts.ExtensionDir)
		}
		opts.ExtensionDir = filepath.Clean(opts.ExtensionDir)
	}
	if opts.ChromeFlatpak && opts.FirefoxFlatpak {
		return parsedCommand{}, errors.New("--chrome-flatpak and --firefox-flatpak cannot be combined; run install once per browser")
	}
	if opts.ChromeFlatpak || opts.FirefoxFlatpak {
		flag := "--chrome-flatpak"
		if opts.FirefoxFlatpak {
			flag = "--firefox-flatpak"
		}
		if opts.BinaryPath != "" || len(opts.Browsers) != 0 || opts.AllBrowsers || opts.UserDataDir != "" {
			return parsedCommand{}, fmt.Errorf("%s cannot be combined with native browser selection flags", flag)
		}
		if opts.ChromeID != chromeWebStoreExtensionID || opts.FirefoxID != firefoxExtensionID {
			return parsedCommand{}, fmt.Errorf("%s requires the stable Tailchrome extension IDs", flag)
		}
		return parsedCommand{Kind: commandInstall, Opts: opts}, nil
	}
	if err := validateExtensionIDs(opts.ChromeID, opts.FirefoxID); err != nil {
		return parsedCommand{}, err
	}
	if opts.UserDataDir != "" {
		if !filepath.IsAbs(opts.UserDataDir) {
			return parsedCommand{}, fmt.Errorf("user-data-dir must be absolute: %q", opts.UserDataDir)
		}
		opts.UserDataDir = filepath.Clean(opts.UserDataDir)
		if info, err := os.Stat(opts.UserDataDir); err == nil && !info.IsDir() {
			return parsedCommand{}, fmt.Errorf("user-data-dir %q is not a directory", opts.UserDataDir)
		}
	}
	return parsedCommand{Kind: commandInstall, Opts: opts}, nil
}

func parseUninstallCommand(args []string) (parsedCommand, error) {
	fs := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var opts registrationOptions
	fs.StringVar(&opts.BinaryPath, "binary-path", "", "absolute path to the invoking executable")
	fs.StringVar(&opts.UserDataDir, "user-data-dir", "", "custom Chromium user-data directory")
	fs.BoolVar(&opts.ChromeFlatpak, "chrome-flatpak", false, "uninstall the Chrome Flatpak helper")
	fs.BoolVar(&opts.FirefoxFlatpak, "firefox-flatpak", false, "uninstall the Firefox Flatpak helper")
	fs.StringVar(&opts.ExtensionDir, "extension-dir", "", "unpacked Chromium extension directory for Chrome Flatpak")
	if err := fs.Parse(args); err != nil {
		return parsedCommand{}, err
	}
	if fs.NArg() != 0 {
		return parsedCommand{}, fmt.Errorf("uninstall: unexpected argument %q", fs.Arg(0))
	}
	if opts.ExtensionDir != "" {
		return parsedCommand{}, errors.New("uninstall does not accept --extension-dir; use --chrome-flatpak")
	}
	if opts.ChromeFlatpak && opts.FirefoxFlatpak {
		return parsedCommand{}, errors.New("--chrome-flatpak and --firefox-flatpak cannot be combined; run uninstall once per browser")
	}
	if opts.ChromeFlatpak || opts.FirefoxFlatpak {
		if opts.BinaryPath != "" || opts.UserDataDir != "" {
			return parsedCommand{}, errors.New("Flatpak uninstall cannot be combined with native uninstall flags")
		}
		return parsedCommand{Kind: commandUninstall, Opts: opts}, nil
	}
	if opts.UserDataDir != "" {
		if !filepath.IsAbs(opts.UserDataDir) {
			return parsedCommand{}, fmt.Errorf("user-data-dir must be absolute: %q", opts.UserDataDir)
		}
		opts.UserDataDir = filepath.Clean(opts.UserDataDir)
	}
	return parsedCommand{Kind: commandUninstall, Opts: opts}, nil
}

func parseLegacyCommand(args []string) (parsedCommand, error) {
	fs := flag.NewFlagSet("legacy", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	installArg := fs.String("install", "", "legacy install argument")
	installNow := fs.Bool("install-now", false, "legacy install-now")
	uninstall := fs.Bool("uninstall", false, "legacy uninstall")
	version := fs.Bool("version", false, "legacy version")
	if err := fs.Parse(args); err != nil {
		return parsedCommand{}, err
	}
	if fs.NArg() != 0 {
		return parsedCommand{}, fmt.Errorf("unexpected legacy argument %q", fs.Arg(0))
	}
	switch {
	case *version:
		return parsedCommand{Kind: commandVersion}, nil
	case *installNow:
		return parsedCommand{Kind: commandLegacyInstallNow}, nil
	case *uninstall:
		return parsedCommand{Kind: commandLegacyUninstall}, nil
	case *installArg != "":
		return parsedCommand{Kind: commandLegacyInstall, Arg: *installArg}, nil
	default:
		return parsedCommand{}, errors.New("no legacy command")
	}
}

func validateExtensionIDs(chromeID, firefoxID string) error {
	if !regexp.MustCompile(`^[a-p]{32}$`).MatchString(chromeID) {
		return fmt.Errorf("invalid Chrome extension ID %q: want 32 lowercase letters a-p", chromeID)
	}
	if !regexp.MustCompile(`^(?:[^\s@]+@[^\s@]+|\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?)$`).MatchString(firefoxID) {
		return fmt.Errorf("invalid Firefox extension ID %q: want an email-like ID or UUID", firefoxID)
	}
	return nil
}

func selectedRegistrationTargets(opts registrationOptions) ([]chromiumBrowserTarget, bool, error) {
	all := chromiumManifestDirs()
	byName := make(map[string]chromiumBrowserTarget, len(all))
	for _, target := range all {
		byName[normalizeBrowserName(target.Name)] = target
	}
	if opts.UserDataDir != "" {
		chrome, ok := byName[normalizeBrowserName("Chrome")]
		if !ok {
			return nil, false, errors.New("Chrome is not supported on this platform")
		}
		chrome.Dir = filepath.Join(opts.UserDataDir, "NativeMessagingHosts")
		byName[normalizeBrowserName("Chrome")] = chrome
	}

	var selected []chromiumBrowserTarget
	firefox := false
	if len(opts.Browsers) != 0 {
		seen := make(map[string]bool)
		for _, name := range opts.Browsers {
			key := normalizeBrowserName(name)
			if key == "firefox" {
				firefox = true
				continue
			}
			target, ok := byName[key]
			if !ok {
				return nil, false, fmt.Errorf("unsupported browser %q", name)
			}
			if !seen[key] {
				selected = append(selected, target)
				seen[key] = true
			}
		}
		if opts.UserDataDir != "" && !seen[normalizeBrowserName("Chrome")] {
			return nil, false, errors.New("--user-data-dir requires --browser Chrome")
		}
		if !firefox && len(selected) == 0 {
			return nil, false, errors.New("at least one browser must be selected")
		}
		return selected, firefox, nil
	}

	if opts.AllBrowsers {
		selected = append(selected, all...)
		firefox = true
		if opts.UserDataDir != "" {
			selected[0] = byName[normalizeBrowserName("Chrome")]
		}
		return selected, firefox, nil
	}
	chrome, ok := byName[normalizeBrowserName("Chrome")]
	if !ok {
		return nil, false, errors.New("Chrome is not supported on this platform")
	}
	selected = append(selected, chrome)
	for _, target := range all {
		if normalizeBrowserName(target.Name) != normalizeBrowserName("Chrome") && browserHasFootprint(target) {
			selected = append(selected, target)
		}
	}
	return selected, true, nil
}

func normalizeBrowserName(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	name = strings.NewReplacer(" ", "", "-", "", "_", "").Replace(name)
	return name
}

func installDirectRegistration(opts registrationOptions) ([]BrowserInstallResult, error) {
	binaryPath, err := validateInvokingBinaryPath(opts.BinaryPath)
	if err != nil {
		return nil, err
	}
	targets, firefox, err := selectedRegistrationTargets(opts)
	if err != nil {
		return nil, err
	}
	snapshots := make([]registrationSnapshot, 0, len(targets)+1)
	for _, target := range targets {
		path := filepath.Join(target.Dir, manifestNameChrome+".json")
		snapshot, err := snapshotChromiumRegistration(target, path)
		if err != nil {
			return nil, fmt.Errorf("snapshot %s registration: %w", target.Name, err)
		}
		snapshots = append(snapshots, snapshot)
	}
	if firefox {
		path := filepath.Join(firefoxManifestDir(), manifestNameFirefox+".json")
		snapshot, err := snapshotFirefoxRegistration(path)
		if err != nil {
			return nil, fmt.Errorf("snapshot Firefox registration: %w", err)
		}
		snapshots = append(snapshots, snapshot)
	}
	results := make([]BrowserInstallResult, 0, len(targets)+1)
	for _, target := range targets {
		parentExisted := browserHasFootprint(target)
		manifestPath := filepath.Join(target.Dir, manifestNameChrome+".json")
		manifest := nativeManifest{
			Name:           manifestNameChrome,
			Description:    "Tailscale Browser Extension Native Messaging Host",
			Path:           binaryPath,
			Type:           "stdio",
			AllowedOrigins: []string{fmt.Sprintf("chrome-extension://%s/", opts.ChromeID)},
		}
		err := installOneChromiumOwned(target, manifest, ownerKindDirect)
		result := BrowserInstallResult{Name: target.Name, ParentExisted: parentExisted, ManifestPath: manifestPath, Err: err}
		if err == nil {
			result.RegistryKeys = platformChromiumRegistryKeys(target)
		}
		results = append(results, result)
	}
	if firefox {
		_, footprintErr := os.Stat(filepath.Dir(firefoxManifestDir()))
		parentExisted := footprintErr == nil
		path := filepath.Join(firefoxManifestDir(), manifestNameFirefox+".json")
		manifest := nativeManifest{
			Name:              manifestNameFirefox,
			Description:       "Tailscale Browser Extension Native Messaging Host",
			Path:              binaryPath,
			Type:              "stdio",
			AllowedExtensions: []string{opts.FirefoxID},
		}
		var err error
		if err = os.MkdirAll(filepath.Dir(path), 0755); err == nil {
			oldManifest, snapshotErr := readOptionalFile(path)
			if snapshotErr != nil {
				err = snapshotErr
			} else {
				oldReceipt, receiptErr := readOptionalFile(registrationReceiptPath(path))
				if receiptErr != nil {
					err = receiptErr
				} else {
					err = writeRegistration(path, manifest, binaryPath, ownerKindDirect)
					if err == nil {
						err = platformPostInstallFirefoxForInstall(path)
					}
					if err != nil {
						if rollbackErr := restoreRegistration(path, oldManifest, oldReceipt); rollbackErr != nil {
							err = errors.Join(err, rollbackErr)
						}
					}
				}
			}
		}
		result := BrowserInstallResult{Name: "Firefox", ParentExisted: parentExisted, ManifestPath: path, Err: err}
		if err == nil {
			result.RegistryKeys = platformFirefoxRegistryKeys()
		}
		results = append(results, result)
	}
	var errs []error
	for _, result := range results {
		if result.Err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", result.Name, result.Err))
		}
	}
	if len(results) == 0 {
		return nil, errors.New("no browsers selected")
	}
	if len(errs) != 0 {
		rollbackErr := rollbackRegistrationSnapshots(snapshots)
		for i := range results {
			if results[i].Err == nil {
				results[i].RolledBack = true
				results[i].RegistryKeys = nil
			}
		}
		return results, errors.Join(append(errs, rollbackErr)...)
	}
	return results, nil
}

func validateInvokingBinaryPath(path string) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("failed to get invoking executable: %w", err)
	}
	if path == "" {
		path = exe
	}
	if strings.IndexByte(path, 0) >= 0 {
		return "", errors.New("binary path contains NUL")
	}
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("binary path must be absolute: %q", path)
	}
	path = filepath.Clean(path)
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("binary path %q is not accessible: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("binary path %q is not a regular file", path)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0111 == 0 {
		return "", fmt.Errorf("binary path %q is not executable", path)
	}
	if !sameExecutablePath(path, exe) {
		return "", fmt.Errorf("binary path %q does not refer to the invoking executable", path)
	}
	// Preserve this spelling in the manifest. In particular, Homebrew's opt
	// path is a stable symlink and must not be replaced with its keg target.
	return path, nil
}
