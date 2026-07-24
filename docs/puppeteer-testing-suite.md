# Puppeteer Testing Suite

Tailchrome's end-to-end harness builds the real Manifest V3 extension, launches it in an isolated Chrome or Firefox profile, and substitutes a deterministic browser-side native-messaging host. It does not require a Tailscale account, installed helper, or external network access.

## Commands

```bash
pnpm e2e                    # Chrome smoke suite
pnpm e2e:chrome             # Chrome smoke suite
pnpm e2e:firefox            # Firefox smoke suite
pnpm e2e:full:chrome        # All Chrome scenarios
pnpm e2e:full:firefox       # All Firefox scenarios
pnpm e2e:full               # Full Chrome, then full Firefox
HEADLESS=false pnpm e2e     # Visible local browser
pnpm e2e --grep=proxy       # Filter case names
```

The default suite is `smoke`; pass `--suite=full` for the complete scenario set. Browser selection accepts `--browser=chrome`, `--browser=firefox`, `--chrome`, or `--firefox`.

The Firefox runner installs the known-compatible `stable_152.0` build because
Firefox 153 currently rejects WebDriver BiDi navigation to extension pages
([Mozilla bug 1959376](https://bugzilla.mozilla.org/show_bug.cgi?id=1959376)).
Set `FIREFOX_BUILD_ID` to test another downloadable build or `FIREFOX_BINARY`
to use an existing Firefox executable.

Passing a pull-request number is supported for local review runs. That mode requires a clean worktree, checks out the requested PR with `gh`, runs the suite, and restores the original branch afterward.

## Implemented Layout

| Path | Responsibility |
| --- | --- |
| `scripts/e2e/run.mjs` | Parses CLI options, builds the selected extension, discovers scenarios, runs cases sequentially, reports failures, and handles optional PR checkout. |
| `scripts/e2e/launch.mjs` | Creates an isolated browser profile, launches Puppeteer, and opens the extension popup/sidebar page. |
| `scripts/e2e/native-host.mjs` | Copies the build to a temporary directory, injects a `connectNative` mock, records commands through a loopback server, and returns scripted replies. |
| `scripts/e2e/fixtures.mjs` | Builds realistic status, peer, profile, and capability fixtures; reads the expected helper version from the extension package. |
| `scripts/e2e/assertions.mjs` | Shared popup, text, input, toggle, and native-request assertions. |
| `scripts/e2e/scenarios/*.mjs` | User-visible workflows. Each module declares its browser support and `smoke` or `full` suite. |

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

Scenarios run sequentially because extension builds and temporary browser state are shared at the suite level. Each case receives its own extension copy, browser profile, mock server, and request log. Temporary artifacts are removed after the case; set `KEEP_E2E_ARTIFACTS=true` to retain a failing case's directory.

## CI

Pull requests run `pnpm e2e:chrome`, which currently includes the Chrome smoke scenarios. The full cross-browser suite remains available for release or focused local verification. When a case fails, the runner prints the native request log and the retained artifact path when artifact retention is enabled.
