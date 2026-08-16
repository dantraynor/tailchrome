# Firefox Smoke Test Matrix

## Matrix

Run the full checklist on:

| OS | Architecture | Firefox | Helper installer |
| --- | --- | --- | --- |
| macOS 14+ | Intel and Apple Silicon | 140+ stable | `tailchrome-helper-macos.pkg` |
| Windows 11 | x64 | 140+ stable | `tailchrome-helper-windows-x64.msi` |
| Ubuntu 24.04+ | amd64 | 140+ stable | `tailchrome-helper-linux-amd64.deb` |
| Ubuntu 24.04+ | arm64 | 140+ stable | verified `tailscale-browser-ext-linux-arm64` fallback |

## Preconditions

- Fresh Firefox profile
- Matching signed Firefox extension build
- Platform-signed macOS/Windows installer, verified Linux package, or the
  architecture-correct verified fallback from the same GitHub Release
- Disposable Tailscale reviewer account
- Test tailnet with MagicDNS peer, subnet route, exit node, and Taildrop target

## Scenarios

### 1. Helper Install

Steps:

1. Open the popup immediately after installing the extension.
2. Confirm the setup-required view appears.
3. Download and run the helper installer for the current OS.
4. Re-open the popup.

Pass:

- The setup-required state clears after the helper is installed.
- No Firefox native messaging permission errors remain in the popup.
- An amd64 profile offers the Debian package first.
- An arm64 profile does not offer an incompatible amd64 package.

### 2. Login Flow

Steps:

1. Click the login action from the popup.
2. Complete login with the disposable account.
3. Return to Firefox and reopen the popup.

Pass:

- Tailnet name and self node appear.
- The extension reaches `Running` state.

### 3. Toggle On / Off

Steps:

1. Toggle Tailchrome off.
2. Confirm tailnet routes stop working.
3. Toggle Tailchrome back on.

Pass:

- Proxy state transitions cleanly between direct and tailnet routing.
- Re-enabling restores running state without reinstalling the helper.

### 4. MagicDNS

Steps:

1. Open a known MagicDNS hostname from the popup or browser location bar.

Pass:

- The host resolves and loads through Tailchrome.

### 5. Subnet Routing

Steps:

1. Open a service that is reachable only through an advertised subnet route.

Pass:

- The request succeeds while Tailchrome is enabled.
- The same target is unreachable after Tailchrome is disabled.

### 6. Exit Nodes

Steps:

1. Select an exit node in the popup.
2. Browse to an external site.
3. Clear the exit node.

Pass:

- External browsing is routed through the selected exit node while enabled.
- Clearing the exit node returns external traffic to direct routing.

### 7. Taildrop

Steps:

1. Send a small text file to a Taildrop-capable peer.

Pass:

- Progress updates appear in the popup.
- The target peer receives the file.

### 8. Browser Restart / Background Wake

Steps:

1. With Tailchrome running, fully quit and restart Firefox.
2. Reopen the popup and access a MagicDNS host.

Pass:

- The extension reconnects to the helper.
- Stored Firefox session proxy state restores routing without manual reconfiguration.

### 9. Missing Helper

Steps:

1. Remove the helper/native messaging manifest.
2. Restart Firefox and open the popup.

Pass:

- The popup says that no registered helper was found without naming a guessed
  browser product, antivirus action, or manifest path.
- The platform release package remains the primary action before an install
  attempt.
- After discovery retries are exhausted, **Repair registration for this
  browser** becomes prominent and survives a background-context restart.
- A successful repair clears the recommendation and returns to the normal
  state.

### 10. Registration Refused

Steps:

1. Keep the helper installed, but remove this Firefox extension ID from its
   `allowed_extensions` registration in the disposable profile.
2. Restart Firefox and open the popup.

Pass:

- The popup says that the browser refused access to the registered helper.
- Registration repair and local diagnostic actions are offered.
- Raw browser error text is absent from the recovery copy.

### 11. Early Start Failure and Later Stop

Steps:

1. Force the registered helper to exit before its first valid reply.
2. Restore it, connect successfully, then terminate it after initialization.

Pass:

- The first case says that the helper stopped before setup completed.
- The second case says that the helper stopped after connecting and shows
  reconnect progress.
- Retry reconnects without changing an unrelated connection preference.
- A healthy reply clears failure state and reconnect backoff.

### 12. Helper-Reported Startup Error

Steps:

1. Use a test helper that returns an `init.error` or `procRunning.error`.

Pass:

- The popup says that the helper reported a startup error.
- The primary copy does not expose the raw helper string.
- The sanitized detail appears only after generating a local diagnostic
  report.

### 13. Helper Release Difference and Capabilities

Steps:

1. Install an older helper package than the extension release.
2. Open the popup.
3. Repeat with a newer helper.
4. Repeat with helpers that omit all optional capability flags and advertise
   one optional capability.

Pass:

- Older and newer versions reach the same normal login/running views.
- A valid difference shows only a non-blocking release notice.
- An unparsable or missing helper version does not create an incompatibility
  error.
- Controls are enabled only for advertised capabilities.
- Version difference alone does not change Firefox proxy recovery or the
  warning badge.

### 14. Local Diagnostic Report

Steps:

1. Trigger one helper failure containing a home-directory path, URL, control
   characters, and oversized text.
2. Click **Copy diagnostic report**.
3. Click **Export diagnostic report**.

Pass:

- Clipboard and file contain the same bounded allowlisted report.
- The report contains the failure category/code and sanitized detail.
- It contains no URL, home-directory user name, browser history/tab data,
  authentication data, tailnet, MagicDNS suffix, Tailscale IP, peer, profile,
  traffic, or Taildrop data.
- No report is created or submitted before either button is clicked.
