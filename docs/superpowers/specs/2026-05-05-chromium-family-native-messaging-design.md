# Native messaging support for Chromium-family browsers

Closes [#66](https://github.com/dantraynor/tailchrome/issues/66).

## Problem

The native helper (`tailscale-browser-ext`) only writes its native messaging
manifest into Google Chrome's directory. Brave, Edge, Vivaldi, Opera, Chromium,
and Arc all use different per-browser directories for native messaging hosts,
so the extension installed in those browsers cannot find the helper after the
user runs the installer.

Reported on Brave 1.89.143 / CachyOS in #66, but the same failure mode applies
to every Chromium-based browser other than Chrome.

The current code paths are:

- Linux: `~/.config/google-chrome/NativeMessagingHosts/` only
  (`host/install_linux.go`)
- macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
  only (`host/install_darwin.go`)
- Windows: registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\` only
  (`host/install_windows.go`)

Firefox is unaffected — Mozilla uses a single shared directory for native
messaging hosts (`~/.mozilla/native-messaging-hosts/` on Linux, equivalent on
macOS, registry on Windows).

## Goal

The helper writes its native messaging manifest to every supported Chromium
browser's location on every supported platform, so the extension works in any
of them without further user action.

## Non-goals

- **Detection-based gating of installs.** We are explicitly choosing the
  always-install-everywhere approach over detect-then-install. A single missed
  detection rule would silently recreate the original bug for someone; the
  always-install approach is self-healing if the user later installs another
  Chromium browser. (We may still inspect filesystem state for output framing
  — see "Output messages" — but never to skip a write.)
- **Popup UI changes.** The install flow in
  `packages/shared/src/popup/views/install-helpers.ts` already speaks
  generically about "the browser" and works as-is for any Chromium browser the
  user installs the extension into.
- **Per-browser CLI flag.** No need for `--install B<id>` for Brave-only,
  `--install E<id>` for Edge-only, etc. Out of scope.
- **System-wide installation.** All registry/manifest writes stay in user-scope
  locations (HKCU on Windows, `~/...` on Linux/macOS). No admin/sudo needed.
- **Edge Add-ons or Brave-specific store listings.** Extension stays on the
  Chrome Web Store + AMO. Cross-store installs use the Chrome Web Store ID by
  virtue of `allowed_origins`.

## Browsers covered

| Browser  | Linux config dir                                     | macOS Application Support dir          | Windows registry path                                            |
| -------- | ---------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| Chrome   | `.config/google-chrome/NativeMessagingHosts`         | `Google/Chrome/NativeMessagingHosts`   | `Software\Google\Chrome\NativeMessagingHosts`                    |
| Chromium | `.config/chromium/NativeMessagingHosts`              | `Chromium/NativeMessagingHosts`        | `Software\Chromium\NativeMessagingHosts`                         |
| Brave    | `.config/BraveSoftware/Brave-Browser/NativeMessagingHosts` | `BraveSoftware/Brave-Browser/NativeMessagingHosts` | `Software\BraveSoftware\Brave-Browser\NativeMessagingHosts` |
| Edge     | `.config/microsoft-edge/NativeMessagingHosts`        | `Microsoft Edge/NativeMessagingHosts`  | `Software\Microsoft\Edge\NativeMessagingHosts`                   |
| Vivaldi  | `.config/vivaldi/NativeMessagingHosts`               | `Vivaldi/NativeMessagingHosts`         | `Software\Vivaldi\NativeMessagingHosts`                          |
| Opera    | `.config/opera/NativeMessagingHosts`                 | `com.operasoftware.Opera/NativeMessagingHosts` | `Software\Opera Software\Opera Stable\NativeMessagingHosts`     |
| Arc      | — (Linux not shipped)                                | `Arc/User Data/NativeMessagingHosts`   | — (Windows not shipped)                                          |

The macOS paths are all rooted at `~/Library/Application Support/`. Linux paths
are rooted at `$HOME`. Windows paths are HKCU registry keys with the manifest
JSON living at `%LOCALAPPDATA%\Tailscale\BrowserExt\<manifest-name>.json`.

The same `chromeWebStoreExtensionID` (`bhfeceecialgilpedkoflminjgcjljll`) is
used for every Chromium browser, because all of them install Chrome Web Store
extensions under that ID and accept the same `chrome-extension://<id>/`
`allowed_origins` entry.

## Design

### Per-platform manifest-target tables

Replace the single `chromeManifestDir()` function in each
`install_<platform>.go` with a per-platform list of (display-name, target)
entries. The target is a directory on Linux/macOS and a registry key path on
Windows.

In `host/install_linux.go`:

```go
func chromiumManifestDirs() []struct{ Name, Dir string } {
    home, _ := os.UserHomeDir()
    return []struct{ Name, Dir string }{
        {"Chrome",   filepath.Join(home, ".config", "google-chrome", "NativeMessagingHosts")},
        {"Chromium", filepath.Join(home, ".config", "chromium", "NativeMessagingHosts")},
        {"Brave",    filepath.Join(home, ".config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts")},
        {"Edge",     filepath.Join(home, ".config", "microsoft-edge", "NativeMessagingHosts")},
        {"Vivaldi",  filepath.Join(home, ".config", "vivaldi", "NativeMessagingHosts")},
        {"Opera",    filepath.Join(home, ".config", "opera", "NativeMessagingHosts")},
    }
}
```

`host/install_darwin.go` mirrors the structure rooted at
`~/Library/Application Support/`, plus an extra `Arc` entry pointing at
`Arc/User Data/NativeMessagingHosts`.

`host/install_windows.go` defines a slice of (display-name, registry-path)
entries instead of directories, because the manifest JSON itself still lives at
a single on-disk path under `%LOCALAPPDATA%\Tailscale\BrowserExt\`. Each
registry key just points at that same JSON file.

### Cross-platform install loop

Rename `installChrome` (in `host/install.go`) to `installChromiumFamily`. It
does what the old `installChrome` did, but in a loop over the per-platform
target list:

1. Build the manifest binary path once via `installBinary()` (unchanged).
2. On Linux/macOS: for each entry in `chromiumManifestDirs()`, `MkdirAll` the
   target directory and write the manifest JSON
   (`<manifestNameChrome>.json`).
3. On Windows: write the manifest JSON once to the existing
   `%LOCALAPPDATA%\Tailscale\BrowserExt\<manifestNameChrome>.json` location,
   then for each entry in the registry-path list, call `createRegistryKey`
   pointing at that JSON file. The single JSON file is referenced from
   multiple registry keys.
4. Collect per-browser errors. If at least one browser succeeds, the function
   returns nil but logs failures. If every browser fails, it returns an
   aggregate error.

The "at least one success" rule matters because user environments routinely
have only one or two of these browsers installed; a write failure to a
non-existent or oddly-permissioned config path for an unused browser shouldn't
block install for the browsers that do exist. Errors are still logged so they
show up in `--install-now` output.

`uninstall()` follows the same shape: loop the list, remove the manifest if it
exists, ignore "not found" errors. Windows additionally deletes each registry
key in the list.

The Firefox install path is unchanged.

### CLI flag semantics

`--install C<extensionID>` historically meant "install for Chrome with this
extension ID." It will now mean "install for the Chromium family with this
extension ID." This is the desired behavior — the flag is rarely used outside
`--install-now`, and the new semantics match the new install model. The case
letter (`C`) is kept for backward compatibility; renaming to a different letter
would needlessly break existing scripts.

`--install-now`, the flag the macOS Helper.app uses, transparently uses the new
loop and reports per-browser status to stdout.

### Output messages

Replace the single "Chrome: installed successfully." line with a per-browser
status line produced inside the loop. Each line reports one of three states:

- `installed` — the parent config dir / vendor registry key existed before
  our write, indicating the browser is in active use on this machine.
- `installed (ready for first use)` — the browser's parent dir / registry key
  did not exist; we created the tree and wrote the manifest. The extension
  will work if the user later installs the browser.
- `failed: <reason>` — the write itself errored (rare; permissions, etc.).

Example output on a machine that has Chrome and Brave but nothing else:

```
Chrome:   installed.
Chromium: installed (ready for first use).
Brave:    installed.
Edge:     installed (ready for first use).
Vivaldi:  installed (ready for first use).
Opera:    installed (ready for first use).
Firefox:  installed.
```

The "did this exist before we wrote?" check uses `os.Stat` on the parent
directory (Linux/macOS) or `registry.OpenKey` on the vendor key (Windows). It
runs *before* the install write, never gates it, and is purely informational.
This keeps the Non-goals constraint ("no detection-based gating") intact while
giving the user a clearer picture of what's now wired up.

## Edge cases and decisions

- **Empty directories for un-installed browsers.** Writing a manifest to
  `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/` when the user
  has never run Brave creates the directory tree. This is harmless: if the
  user later installs Brave, the manifest is already there. The directories
  are user-scope and a few hundred bytes total. Documented here so we don't
  field "why is there a Brave folder in my config?" bug reports later.

- **Windows HKCU vs HKLM.** All registry writes stay in HKCU (current user).
  This matches existing Chrome behavior and avoids any admin/UAC requirement.
  System-wide install is out of scope.

- **Edge case: locked-down or read-only directories.** A user could in
  principle have a read-only `~/.config/microsoft-edge/` (e.g. an enterprise
  policy puts an immutable directory there). We log and continue rather than
  abort, so other browsers still get installed.

- **Single shared manifest JSON file on Windows.** Existing code already writes
  one JSON at `%LOCALAPPDATA%\Tailscale\BrowserExt\<manifest-name>.json` and
  points the Chrome registry key at it. We keep this — only the registry-key
  list grows. Multiple registry keys safely point at the same JSON file.

- **macOS `.pkg` installer.** The `Tailchrome Helper.app` invokes
  `tailscale-browser-ext --install-now`, which uses the new loop. No change to
  the .pkg build pipeline.

- **Existing installs.** Users who installed before this change keep their
  Chrome manifest. Re-running the installer (or letting the popup's "update
  helper" flow trigger it) will idempotently add Brave/etc. manifests
  alongside the existing Chrome one. No migration needed.

## Testing

Add a unit test in `host/install_test.go` that:

1. Sets `HOME` (or the Windows equivalent) to a temp directory.
2. Calls `installChromiumFamily(testExtensionID)`.
3. Asserts that a manifest JSON exists at every directory in
   `chromiumManifestDirs()` with the expected name, path, type, and
   `allowed_origins` content.
4. Calls `uninstall()` and asserts the files are gone.

A separate per-platform test verifies that the platform's list of target
directories is non-empty and contains at least Chrome and Brave.

Manual verification:

- Linux: drop the binary in a temp HOME, run `--install-now`, inspect each
  config dir.
- macOS: build the .pkg locally, install, run the Helper.app, inspect each
  Application Support subdirectory.
- Windows: run `--install-now`, inspect the registry tree under
  `HKCU\Software\` for each vendor.

## Out-of-scope cleanups noticed but not addressed here

- The bug-report issue template
  (`.github/ISSUE_TEMPLATE/bug_report.yml`) only lists "Chrome", "Firefox",
  "Other" in the browser dropdown. Adding Brave/Edge/Vivaldi/Opera/Chromium/Arc
  would help triage but is unrelated to the install fix. Leaving for a separate
  change.
- Some existing Linux `isBrowserInstalled` logic uses `exec.LookPath` to detect
  Chrome and Firefox; it isn't extended for Brave/etc. because the new install
  flow doesn't depend on detection. If we ever want to revive
  detect-then-install, that's where the work would go.
