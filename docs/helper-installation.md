# Helper installation

The commands on this page describe v0.1.14 and later. The helper release must
be published before the matching extension is distributed. For older releases,
use their attached installer instructions and legacy flags.

Upgrade the helper and extension together from v0.1.13 or earlier. v0.1.14
requires an authenticated proxy: its extension rejects an older helper without
credentials, and an older extension cannot authenticate to its helper. Complete
both updates before resuming protected browsing. Version differences alone
remain informational when the required protocol is supported.

## One installation for your account

The popup selects the setup flow for your operating system. Linux uses one
copyable terminal command. macOS provides a signed helper app and a terminal
alternative. Windows provides a per-user x64 MSI and a PowerShell installer
that selects the native OS architecture, including ARM64. System packages and
Homebrew are alternative installation methods.

The scripts resolve the latest stable release once, download that release's
helper and `SHA256SUMS.txt`, verify the helper, and register its final path.
GitHub attestation verification runs when the authenticated GitHub CLI supports
it. Signing follows the release's documented policy; a checksum does not turn
an unsigned Windows release into a signed one.

To inspect or pin the Unix installer, download `tailchrome-install.sh` from the
chosen release, inspect it, then run:

```bash
bash ./tailchrome-install.sh --version v0.1.14
```

For the Windows script downloaded from that release:

```powershell
& .\tailchrome-install.ps1 -Version v0.1.14
```

The PowerShell installer requires a valid Authenticode signature by default.
For a release explicitly published in the repository's unsigned mode, inspect
its release notes and use `-AllowUnsigned` to accept an absent signature.
That option does not accept an invalid signature.

### Windows Security blocks the helper

`-AllowUnsigned` only accepts an absent Authenticode signature. It cannot
override a Defender malware or potentially unwanted software detection, and
a matching checksum does not establish that Defender will accept a file.

If Windows blocks or quarantines the helper, stop installation and open
**Windows Security → Virus & threat protection → Protection history**. Record
the threat name, release version, affected path, and release artifact's SHA-256
hash when reporting the problem. Do not disable protection or add exclusions.
Maintainers should submit the exact detected release file through
[Microsoft's file submission portal](https://www.microsoft.com/en-us/wdsi/filesubmission)
for review, then verify the same artifact against updated security intelligence.
Use a release whose detection has been resolved before retrying installation.
The installer preserves the previous executable when rollback is possible;
it cannot restore a file that antivirus has also quarantined.

New release candidates require clean Defender evidence for both signed and
explicitly unsigned Windows artifacts. This does not retroactively clear
detections of the v0.1.14 binaries.

Rerunning the same installer upgrades the helper and repairs registration. Close
browsers using Tailchrome before Windows upgrades; an active executable is
preserved and the installer reports that it is busy. Failed replacements keep
the previous binary or report the retained recovery path. No installer deletes
Tailscale identities or browser extension storage.

## Executable ownership

| Method | Registered executable |
| --- | --- |
| macOS/Linux script | `~/.local/bin/tailchrome` |
| Windows script | `%LOCALAPPDATA%\Tailchrome\tailchrome.exe` |
| Homebrew formula | The formula's stable `opt/bin/tailscale-browser-ext` path |
| macOS user app | `~/Applications/Tailchrome Helper.app/Contents/MacOS/tailscale-browser-ext` |
| macOS system package | `/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext` |
| Windows MSI | Its payload under `%LOCALAPPDATA%\Tailscale\BrowserExt\installer\` |
| Linux system package | `/usr/lib/tailchrome/tailscale-browser-ext` |

Choose one installation method per account. Registration points directly at
that method's executable. New uninstall commands preserve registrations owned
by a replacement installation. Package managers remain responsible for removing
package-owned executables. Already-released v0.1.13 and older uninstallers do
not understand ownership receipts: remove those packages before switching
methods, or rerun the new helper's `install` command after removing them.

The browser uses an absolute executable path. It does not require your shell's
`PATH` to contain the helper directory. The examples below use `tailchrome`;
use the table's full path if that command is not on your PATH.

## Registration CLI

```text
tailchrome install
tailchrome install --chrome-id <extension-id> --firefox-id <addon-id>
tailchrome install --browser Brave
tailchrome install --all-browsers
tailchrome install --user-data-dir /absolute/chromium-user-data
tailchrome install --binary-path /absolute/stable/helper-path
tailchrome uninstall
tailchrome uninstall --user-data-dir /absolute/chromium-user-data
tailchrome version
```

`install` registers the already-installed executable; it does not create a
second runtime copy. The default registers Chrome and Firefox for first use,
plus optional browsers with an existing footprint. `--browser` can be repeated
to explicitly register browsers that have not created their configuration
directory yet. `--all-browsers` retains the previous broad registration choice.
The command reports written manifest paths and Windows registry keys.

An explicit `--binary-path` must refer to the invoking executable. Its stable
symlink path is preserved in manifests, which lets Homebrew switch versions
without another registration step. A temporary download path is not a suitable
permanent registration target.

Linux Chromium registration honors absolute XDG configuration paths and
documented Chrome-specific configuration overrides. Firefox keeps its separate
native-messaging location. Custom Chromium data directories use
`--user-data-dir` and must be absolute. Pass the same directory when removing
that registration.

### Custom Chrome profiles and forks

Chrome launched with `--user-data-dir` looks for the native messaging manifest
inside that directory. In `chrome://version` (or `edge://version`), find
**Profile Path** and use its parent directory, not the browser executable or
the individual `Default` / `Profile 2` directory. For example, the profile
`/home/box/chrome-profile/Fork-4/Profile 2` uses:

```bash
bash ./tailchrome-install.sh --user-data-dir '/home/box/chrome-profile/Fork-4'
```

For an already installed helper, including one installed through a package
manager, register it without downloading again:

```bash
tailchrome install --browser Chrome --user-data-dir '/home/box/chrome-profile/Fork-4'
```

This writes `NativeMessagingHosts/com.tailscale.browserext.chrome.json` under
the selected root without root privileges on Linux/macOS. Repeat registration
for each separate fork's data root. Restart the browser afterward. The Unix
script's printed removal command retains the selected root; when registering
additional roots manually, unregister each with `tailchrome uninstall
--user-data-dir /absolute/root` before removing the executable. Windows uses
current-user registry registration instead of this directory lookup.

Legacy `-install-now`, `--install C<id>`, `--install F<id>`, `-uninstall`, and
`-version` remain available to existing callers. Legacy installation retains
its historical runtime-copy behavior; new installers use the direct commands.
The native-host names and released extension IDs are unchanged.

## Removal

`tailchrome uninstall` removes registrations owned by that executable and keeps
the executable and node state. Supply the same stable `--binary-path` used for
registration when invoking a package executable through a different path.

To remove a script-managed helper as well, copy the removal command printed
after installation. It reuses a saved installer or downloads the same release's
installer when setup ran without saving a file. The command includes the
installation directory, including a custom directory if you chose one.

If you saved the installer, you can also run its `--uninstall` option on
macOS/Linux or `-Uninstall` on Windows; pass the original `--bin-dir` or
`-BinDir` when using a custom directory. The script waits for unregister to
succeed before removing its executable. Use the package manager or Windows
Installed apps for package installations.

## Chrome Flatpak

Chrome Flatpak support is opt-in and separate from native browser registration.
Install and launch `com.google.Chrome` once, then fully close it, including
background processes. Install the Tailchrome extension inside that browser,
then run the helper outside the sandbox:

```text
tailchrome install --chrome-flatpak
```

The installer stages the helper and native-messaging manifest inside Chrome's
app directory. The store extension retains its normal browser-managed updates.
Native registration, other extensions, and native node identities are left in
place. The helper uses the sandbox's writable XDG configuration directory for
its separate node state; changing the native shell's XDG path does not move it.

For development builds, `install --chrome-flatpak --extension-dir /absolute/bundle`
can stage an unpacked MV3 extension with Tailchrome's expected key and ID. Load
the staged `~/.var/app/com.google.Chrome/tailchrome/extension` directory through
Chrome's extension developer settings. This is optional; the store extension
keeps its normal update mechanism. Modified staged bundles are preserved and
must be reviewed before replacement.

Fully close Chrome before upgrading or removing its sandbox helper:

```text
tailchrome uninstall --chrome-flatpak
```

Removal preserves Chrome's extension storage and Tailchrome's node state. An
app-scoped lock prevents concurrent modification. No broad Flatpak filesystem
override or host-process escape is required. This feature requires real Chrome
Flatpak launch, login, routing, and upgrade validation on a Linux machine that
supports Flatpak namespaces; filesystem fixture tests alone are insufficient.
`scripts/test-flatpak.sh` exercises the helper protocol inside the sandbox on a
clean test account. It does not establish store-extension discovery or login.
The manual **Chrome Flatpak helper smoke** workflow runs that check on a clean
Linux runner without widening the app's sandbox permissions.
