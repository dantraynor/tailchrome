# Firefox Smoke Test Matrix

## Matrix

Run the full checklist on:

| OS | Firefox | Helper binary |
| --- | --- | --- |
| macOS 14+ | 140+ stable | `tailscale-browser-ext-darwin-arm64` or `tailscale-browser-ext-darwin-amd64` |
| Windows 11 | 140+ stable | `tailscale-browser-ext-windows-amd64.exe` |
| Ubuntu 24.04+ | 140+ stable | `tailscale-browser-ext-linux-amd64` |

## Preconditions

- Fresh Firefox profile
- Matching signed Firefox extension build
- Matching helper binary from the same GitHub Release
- Disposable Tailscale reviewer account
- Test tailnet with MagicDNS peer, subnet route, exit node, and Taildrop target

## Scenarios

### 1. Helper Install

Steps:

1. Open the popup immediately after installing the extension.
2. Confirm the setup-required view appears.
3. Download and run the helper for the current OS.
4. Re-open the popup.

Pass:

- The setup-required state clears after the helper is installed.
- No Firefox native messaging permission errors remain in the popup.

### 2. Login Flow

Steps:

1. Click the login action from the popup.
2. Complete login with the disposable account.
3. Return to Firefox and reopen the popup.

Pass:

- Tailnet name and self node appear.
- The extension reaches `Running` state without a version mismatch.

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

- The popup returns to setup-required state.
- The user-facing recovery path points to the helper download and run instructions.

### 10. Helper Version Mismatch

Steps:

1. Install an older helper binary than the extension expects.
2. Open the popup.

Pass:

- The popup shows the update-required state.
- The download action points to the latest helper release asset.
