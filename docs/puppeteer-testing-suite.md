# Puppeteer Testing Suite Design

This design expands the current `pnpm e2e` smoke runner into a full browser automation suite for Tailchrome. The suite exercises the built extension in real Chrome and Firefox profiles, while replacing the native helper with a controllable browser-side native messaging mock for deterministic feature coverage.

## Goals

- Test the packaged MV3 extension, not isolated popup HTML.
- Cover Chrome and Firefox behavior with the same scenario definitions where possible.
- Drive user-visible workflows through Puppeteer: popup rendering, clicks, keyboard input, file chooser flows, tabs, storage, and extension background side effects.
- Keep tests hermetic by using a fake native messaging host, temp browser profile, temp extension copy, and no real Tailscale account.
- Preserve one small smoke command for quick local checks, and add fuller suites for CI and release confidence.

## Test Architecture

### Runner

Keep `scripts/e2e/run.mjs` as the entrypoint, but split it into reusable modules:

- `scripts/e2e/cli.mjs`: parse browser, suite, headed/headless, PR checkout, and grep filters.
- `scripts/e2e/build-extension.mjs`: build `chrome-mv3` or `firefox-mv3`.
- `scripts/e2e/browser.mjs`: launch Puppeteer with the built extension and isolated profile.
- `scripts/e2e/native-host.mjs`: inject and control the fake native host.
- `scripts/e2e/assertions.mjs`: popup, tab, storage, and native request helpers.
- `scripts/e2e/scenarios/*.mjs`: feature scenarios.

Suggested scripts:

```json
{
  "e2e": "node ./scripts/e2e/run.mjs --suite=smoke",
  "e2e:chrome": "node ./scripts/e2e/run.mjs --browser=chrome --suite=smoke",
  "e2e:firefox": "node ./scripts/e2e/run.mjs --browser=firefox --suite=smoke",
  "e2e:full": "node ./scripts/e2e/run.mjs --browser=chrome --suite=full && node ./scripts/e2e/run.mjs --browser=firefox --suite=full",
  "e2e:headed": "HEADLESS=false node ./scripts/e2e/run.mjs --suite=smoke"
}
```

### Fake Native Messaging Host

`scripts/e2e/native-host.mjs` copies the built extension to a temp directory for each scenario and prepends a small mock to `background.js`. The mock overrides `chrome.runtime.connectNative`, serves scenario control state from a local loopback HTTP server, and records every native request for assertions.

The fake host should support:

- Startup replies: `procRunning`, including `port`, `version`, `supportsNetcheck`, and `supportsPingPeer`.
- Init flow: respond to `init`, then support `get-status` and `list-profiles`.
- Command recording: `up`, `down`, `set-exit-node`, `set-prefs`, `switch-profile`, `new-profile`, `delete-profile`, `send-file`, `suggest-exit-node`, `ping-peer`, `netcheck`, `logout`.
- Scripted pushes: status changes, profile changes, exit node suggestions, file progress, diagnostic replies, and errors.
- Failure modes: host absent, install error, version mismatch, disconnect/reconnect, delayed replies.

### Extension Isolation

For each scenario, the runner creates a temp copy of the built extension and injects the native messaging mock into that copy only. The source build output stays untouched, and cleanup removes the temp copy and loopback server after each case.

### Scenario State Fixtures

Add a fixture builder rather than hand-writing large state objects in each scenario:

- `makeRunningState(overrides)`
- `makeNeedsLoginState(overrides)`
- `makeStoppedState(overrides)`
- `makeNeedsInstallState(overrides)`
- `makePeer(overrides)`
- `makeExitNodePeer(overrides)`
- `makeMullvadPeer(overrides)`
- `makeProfiles(overrides)`

These should mirror `packages/shared/src/__test__/fixtures.ts`, with richer defaults for e2e coverage.

## Scenario Matrix

### Smoke

`popup-loads.mjs`

- Build extension.
- Launch browser with extension loaded.
- Open popup.
- Assert the spinner is replaced by a real `.view`.
- Assert no page errors or console errors.

### Connection States

`connection-states.mjs`

- Host unavailable shows install instructions.
- Host version mismatch shows update UI.
- `NeedsLogin` shows login button and disabled toggle.
- `Stopped` and `NoState` show disconnected UI.
- `Starting` shows progress/spinner state.
- `NeedsMachineAuth` and `InUseOtherUser` show contextual error states.
- Reconnect state shows reconnecting copy and does not enable proxy.

### Login And External Tabs

`login-and-links.mjs`

- Login button opens `browseToURL` only for allowed origins.
- Invalid login origins are ignored.
- Admin footer opens `https://login.tailscale.com/admin`.
- Local node row opens `http://100.100.100.100`.
- GitHub footer link opens the project URL.

### Toggle And Background Commands

`toggle-commands.mjs`

- Connected toggle sends native `down`.
- Stopped toggle sends native `up`.
- Starting toggle shows informational toast and sends no command.
- NeedsLogin toggle shows login-required toast and sends no command.
- Native host unreachable on toggle shows error toast.

### Connected Dashboard

`connected-dashboard.mjs`

- Renders tailnet name, self node IP, hostname, host version, and key expiry.
- Renders health warnings, supports collapse/expand by click and keyboard.
- Shows online and offline peer groups with counts.
- Updates in place when state changes without collapsing an expanded peer row.
- Search filters peers by hostname, DNS name, IP, owner, tag, subnet, and OS.
- Empty peer list shows the expected empty state.

### Peer Actions

`peer-actions.mjs`

- Expanding a peer by click and keyboard reveals actions.
- Copy IP writes the Tailscale IP to clipboard and shows toast.
- Copy DNS writes short DNS name to clipboard and shows toast.
- Open creates a tab for the default peer URL.
- Set URL saves a port and changes button text to `Open :<port>`.
- Set URL saves a full URL and changes button text to `Open (custom)`.
- Clear URL removes storage and reverts the open button.
- Ping sends `ping-peer` only when host support is advertised.
- SSH opens `http://100.100.100.100/ssh/<hostname>` only for SSH-capable online peers.
- Send File sends one native `send-file` request for small files.
- Send File sends chunked requests for files larger than the chunk threshold.
- Oversized files show an error toast and send no native request.

### Exit Nodes

`exit-nodes.mjs`

- Opening the exit node view sends `suggest-exit-node`.
- Renders `None (direct connection)`, recommended node, own devices, shared nodes, and Mullvad groups.
- Selecting an exit node sends `set-exit-node` and persists `lastExitNodeID`.
- Clearing exit node sends empty `set-exit-node` and removes `lastExitNodeID`.
- Allow LAN access sends `set-prefs.exitNodeAllowLANAccess`.
- Recommended row hides during search.
- Search filters by hostname, city, country, and country code.
- No matching search shows empty state.
- Mullvad countries expand/collapse by click and keyboard.
- Active Mullvad country auto-expands on first render.
- Live state updates refresh the sub-view without returning to the dashboard.

### Preferences

`preferences.mjs`

- Shields Up toggle sends `set-prefs.shieldsUp`.
- MagicDNS toggle sends `set-prefs.corpDNS`.
- Advanced settings reveal local settings without layout breakage.
- Advertise Exit Node toggle sends `set-prefs.advertiseExitNode`.
- Advertise Routes editor normalizes newline/comma-separated routes and sends `set-prefs.advertiseRoutes`.
- Preference controls stay stable across state updates.

### Profiles

`profiles.mjs`

- Profile row opens the profile sub-view.
- Current profile is marked selected.
- Selecting another profile sends `switch-profile`.
- Add Profile sends `new-profile`.
- Delete sends `delete-profile` after confirmation.
- Delete is hidden or disabled for the current profile.
- Live profile updates refresh the sub-view without returning to the dashboard.

### Diagnostics And Toasts

`diagnostics.mjs`

- Ping diagnostic reply renders ephemeral toast.
- Netcheck command sends `netcheck` when exposed in UI.
- Native generic errors show error toasts.
- Suggest-exit-node errors are logged but do not show disruptive toasts.
- File progress replies update persistent toast, success, and failure states.

### Proxy And Routing

`proxy-routing.mjs`

- Chrome: when Running with a proxy port, `chrome.proxy.settings` receives a PAC script.
- Chrome: tailnet IPs, MagicDNS names, and subnets route through the local proxy.
- Chrome: non-tailnet traffic routes direct when no exit node is active.
- Chrome: non-tailnet traffic routes through proxy when an exit node is active.
- Chrome: LAN access bypasses local network ranges when enabled.
- Firefox: `browser.proxy.onRequest` listener returns proxy/direct decisions matching Chrome semantics.
- Disconnect clears proxy state.

This can be implemented with extension background introspection and controlled pages rather than real network requests.

### Context Menu Taildrop

`context-menu-taildrop.mjs`

- Extension creates `tailscale-send-page` on install.
- Clicking context menu while Running sends page URL to the first online Taildrop-capable peer.
- Non-running state sends nothing.
- No eligible Taildrop peer sends nothing.
- Encoded file payload decodes back to the page URL.

### Persistence And Reconnect

`persistence-reconnect.mjs`

- Last selected exit node is restored after reconnect when state is Running and no exit node is active.
- Reconnect clears transient host flags and resets proxy state.
- `procRunning` with capability flags updates UI availability.
- Host disconnect followed by reconnect reinitializes and requests status/profile list again.

### Browser Parity

Every scenario should declare browser support:

```js
export const browsers = ["chrome", "firefox"];
export const suite = "full";
```

Only browser-specific internals, such as proxy inspection, should use browser-specific scenarios. User workflows should run in both browsers.

## Assertions And Selectors

The current UI relies mostly on class selectors and text. For stable e2e tests, add explicit `data-testid` attributes to interactive surfaces as scenarios are implemented:

- `popup-root`
- `main-toggle`
- `login-button`
- `peer-search`
- `peer-row:<peer-id>`
- `peer-action:<peer-id>:copy-ip`
- `peer-action:<peer-id>:copy-dns`
- `peer-action:<peer-id>:open`
- `peer-action:<peer-id>:set-url`
- `exit-node-row:<node-id>`
- `exit-node-none`
- `allow-lan-checkbox`
- `profile-row:<profile-id>`
- `toast`

Do this incrementally with the scenario that needs each selector. Avoid broad selector churn before tests exist.

## CI Strategy

Use three levels:

1. `pnpm e2e`: Chrome smoke, runs on every PR after build.
2. `pnpm e2e:full --browser=chrome`: full Chrome suite, runs on main and release candidates.
3. `pnpm e2e:full`: full Chrome and Firefox suite, runs nightly or before release.

Artifacts to upload on failure:

- Scenario stdout/stderr.
- Browser console logs.
- Screenshots of the popup and any opened tabs.
- Fake native host request log.
- Built extension manifest.

## Rollout Plan

1. Extract the current runner into modules without changing behavior.
2. Add the fake native host and manifest installer.
3. Convert `popup-loads` to use the fake host.
4. Add fixture builders and request-log assertions.
5. Implement scenarios in this order: connection states, toggle commands, connected dashboard, peer actions, exit nodes, preferences, profiles, diagnostics, persistence.
6. Add browser-specific proxy and context-menu scenarios.
7. Add stable `data-testid` attributes only where scenarios need them.
8. Wire `e2e:full` into CI after Chrome is stable, then add Firefox parity.

## Definition Of Done

- `pnpm e2e` remains fast and passes locally without a real native helper.
- `pnpm e2e:full` covers all user-facing extension features listed in `docs/DOCUMENTATION.md`.
- Chrome and Firefox scenarios share fixtures and assertions wherever behavior is intended to match.
- Failures include enough artifacts to debug without rerunning locally.
- No test requires a real Tailscale account, real tailnet, real native helper, or external network access.
