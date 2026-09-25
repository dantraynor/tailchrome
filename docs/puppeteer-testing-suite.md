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
pnpm e2e:firefox --grep=cross-extension-proxy-auth  # Firefox HTTPS proxy auth
pnpm e2e:proxy-auth:chrome  # Chrome HTTPS proxy auth and helper restart
```

The default suite is `smoke`; pass `--suite=full` for the complete scenario set. Browser selection accepts `--browser=chrome`, `--browser=firefox`, `--chrome`, or `--firefox`.

The cross-extension HTTPS tests require `openssl` on `PATH` to generate a temporary, self-signed certificate for the local origin.

To test an unpacked release artifact without rebuilding it, set
`E2E_EXTENSION_DIR` to its directory. Relative paths resolve from the repository
root. Use the matching browser for each artifact:

```bash
E2E_EXTENSION_DIR=.context/candidate/chrome pnpm e2e:full:chrome
E2E_EXTENSION_DIR=.context/candidate/firefox pnpm e2e:full:firefox
```

The runner still copies the extension into each case's temporary directory
before injecting the native-messaging mock; the supplied artifact is unchanged.

The Firefox runner installs the verified `stable_156.0` build. Its isolated
test profile enables `--remote-allow-system-access`, which Firefox requires
for WebDriver BiDi navigation to extension pages. This grants the local
automation client privileged browser access only for the test process; it
does not change the packaged extension or the user's browser profile.
See [Mozilla's remote protocol documentation](https://firefox-source-docs.mozilla.org/remote/Prefs.html).
Set `FIREFOX_BUILD_ID` to test another downloadable build or `FIREFOX_BINARY`
to use an existing Firefox executable.

Current Firefox also rejects BiDi keyboard actions on extension pages. When
that exact protocol error occurs, input helpers set the DOM field value and
dispatch its `input` event; all subsequent UI and native-request assertions
still run. The runner logs each fallback. These cases verify input handling,
but physical keyboard interaction still requires a manual browser check.

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
- `cross-extension-proxy-auth`: a second Firefox extension's first HTTPS request traverses Tailchrome's authenticated SOCKS proxy with an exit node selected; adapted from Ender-Wang's [PR #136](https://github.com/dantraynor/tailchrome/pull/136).
- `split-dns`: Chrome sends restricted-domain hostnames to a local authenticated HTTP proxy without an exit node; domain replacement and removal update routing.
- `routing-failclosed-network`: real HTTP requests stay blocked when an exit node or helper disappears; recovery uses the proxy and an explicit bypass goes direct.
- `dns-routing-network`: restricted domains use the proxy, missing updates retain routes, confirmed removals clear them, and helper loss blocks requests.
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

Pull requests run `pnpm e2e:chrome`, which currently includes the Chrome smoke scenarios, plus the standalone Chrome cross-extension HTTPS test. The Firefox review job runs the cross-extension HTTPS scenario against its packaged build. The full cross-browser suite remains available for release or focused local verification. When a case fails, the runner prints the native request log and the retained artifact path when artifact retention is enabled.
