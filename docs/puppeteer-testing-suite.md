# Browser Integration and Windows E2E

Tailchrome has two browser-level test layers:

- The fast browser integration suite builds the real Manifest V3 extension, launches it in an isolated Chrome or Firefox profile, and substitutes a deterministic browser-side native-messaging host. It does not require a Tailscale account, installed helper, or external network access.
- The Windows E2E provisions a disposable Daytona Windows sandbox and exercises the real Go helper, MSI installer, Windows registry, unmodified Chrome extension, and native-messaging transport.

## Commands

```bash
pnpm test:browser                    # Chrome smoke suite
pnpm test:browser:chrome             # Chrome smoke suite
pnpm test:browser:firefox            # Firefox smoke suite
pnpm test:browser:full:chrome        # All Chrome scenarios
pnpm test:browser:full:firefox       # All Firefox scenarios
pnpm test:browser:full               # Full Chrome, then full Firefox
HEADLESS=false pnpm test:browser     # Visible local browser
pnpm test:browser --grep=proxy       # Filter case names
pnpm e2e                             # Real Windows system E2E in Daytona
pnpm e2e:windows                     # Same Windows system E2E
```

The default suite is `smoke`; pass `--suite=full` for the complete scenario set. Browser selection accepts `--browser=chrome`, `--browser=firefox`, `--chrome`, or `--firefox`.

The Firefox runner installs the known-compatible `stable_152.0.6` build because
Firefox 153 currently rejects WebDriver BiDi navigation to extension pages
([Mozilla bug 1959376](https://bugzilla.mozilla.org/show_bug.cgi?id=1959376)).
Set `FIREFOX_BUILD_ID` to test another downloadable build or `FIREFOX_BINARY`
to use an existing Firefox executable.

Passing a pull-request number to `pnpm test:browser` is supported for local review runs. That mode requires a clean worktree, checks out the requested PR with `gh`, runs the suite, and restores the original branch afterward.

## Implemented Layout

| Path | Responsibility |
| --- | --- |
| `scripts/e2e/run.mjs` | Parses CLI options, builds the selected extension, discovers scenarios, runs cases sequentially, reports failures, and handles optional PR checkout. |
| `scripts/e2e/launch.mjs` | Creates an isolated browser profile, launches Puppeteer, and opens the extension popup/sidebar page. |
| `scripts/e2e/native-host.mjs` | Copies the build to a temporary directory, injects a `connectNative` mock, records commands through a loopback server, and returns scripted replies. |
| `scripts/e2e/fixtures.mjs` | Builds realistic status, peer, profile, and capability fixtures; reads the expected helper version from the extension package. |
| `scripts/e2e/assertions.mjs` | Shared popup, text, input, toggle, and native-request assertions. |
| `scripts/e2e/scenarios/*.mjs` | User-visible workflows. Each module declares its browser support and `smoke` or `full` suite. |
| `scripts/e2e/windows-daytona.mjs` | Archives the current tracked and non-ignored worktree, provisions the Windows sandbox, streams the run, retrieves MSI logs, and deletes the sandbox. |
| `scripts/e2e/windows-bootstrap.ps1` | Installs pinned, workspace-local Node.js, Go, and .NET SDK toolchains inside the sandbox. |
| `scripts/e2e/windows-system.mjs` | Runs Windows Go tests, builds the helper/extension/MSI, verifies installation and the real Chrome handshake, then verifies uninstall cleanup. |

## Native-Host Control

`makeControl()` supplies startup state (`procRunning` capabilities, status, profiles, and exit-node recommendation). A scenario can set `commandReplies` to make a command produce a later native reply:

```js
makeControl({
  commandReplies: {
    down: { status: makeStoppedState() },
    "switch-profile": {
      profiles: makeProfiles({
        current: { id: "personal", name: "Personal" },
      }),
    },
  },
});
```

An array provides sequential replies for repeated commands. Every request is still recorded and can be checked with `waitForRequest`. The fixture mirrors the real helper's advertised capabilities: `netcheck` is disabled by default, ping/login/custom-control support is enabled, and unsupported netcheck diagnostics use the real helper text.

## Current Scenarios

- `popup-loads`: packaged popup renders without page or console errors.
- `proxy-routing`: Chrome installs a PAC containing service IP, IPv4/IPv6 tailnet ranges, MagicDNS, and subnet routes.
- `connection-states`: install, update, login, stopped, and machine-approval views.
- `toggle-commands`: `up`/`down` commands plus their resulting UI transitions.
- `connected-dashboard`: identity, helper version, health warnings, peers, and search.
- `split-tunneling`: bypass/only PAC behavior, unsaved textarea changes, and empty-only rules.
- `exit-nodes`: recommendation, selection, LAN access, grouping, and filtering.
- `preferences-profiles-diagnostics`: preferences, advertised routes, live profile switching, and logout.
- `peer-actions`: copy/open/ping/SSH/custom URL/Taildrop actions.
- `login-and-links`: validated login flow and external/local-node links.

Scenarios run sequentially because extension builds and temporary browser state are shared at the suite level. Each case receives its own extension copy, browser profile, mock server, and request log. Temporary artifacts are removed after the case; set `KEEP_BROWSER_TEST_ARTIFACTS=true` to retain a failing case's directory.

## Windows System E2E

`pnpm e2e` requires `DAYTONA_API_KEY` in the process environment. Keep the value in a credential store and inject it only for the command; do not put it in a repository file. `DAYTONA_TARGET` is optional, and `DAYTONA_WINDOWS_SNAPSHOT` defaults to `windows-medium`.

The runner uploads the current tracked and non-ignored worktree, so local source changes are tested without uploading `.env` files, private keys, `node_modules`, build output, or `.context`. Every sandbox is ephemeral, has a 60-minute wall-clock TTL, and is explicitly deleted in a `finally` block. `DAYTONA_E2E_TTL_MINUTES` can set a 15–240 minute TTL. For diagnosis, `KEEP_DAYTONA_SANDBOX_ON_FAILURE=true` retains a failed sandbox until its TTL expires.

The Windows run verifies this sequence:

1. Install the pinned toolchain without modifying the base image globally.
2. Run the Windows-only Go tests and build the helper.
3. Build the unmodified Chrome extension and unsigned test MSI.
4. Install the per-user MSI silently.
5. Verify the staged/runtime binaries, hashes, manifests, all supported HKCU registrations, extension IDs, and helper version.
6. Load the extension in Chrome and establish a real `chrome.runtime.connectNative` handshake with the installed helper.
7. Uninstall the MSI and verify that binaries, manifests, and registry keys are gone.

MSI logs are downloaded to `dist/daytona-windows-e2e/<sandbox-id>/` before the sandbox is deleted.

## CI

Pull requests run `pnpm test:browser:chrome` for fast Chrome coverage. The Daytona Windows job runs for relevant internal pull requests when the repository variable `DAYTONA_WINDOWS_E2E_ENABLED` is `true`; it reads `DAYTONA_API_KEY` from a repository secret and `DAYTONA_TARGET` from a repository variable. Until Windows sandbox access is enabled, or for fork and Dependabot pull requests where secrets are unavailable, CI keeps the Windows runner Go-test fallback. The full cross-browser integration suite remains available for focused verification.
