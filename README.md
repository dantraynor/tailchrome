# Tailchrome

Access your Tailscale network directly from your browser. No system VPN required.

<img width="1400" height="560" alt="Tailchrome routes a private tailnet inside the browser" src="store-assets/promo-marquee-v2.png" />

[Chrome Web Store](https://chromewebstore.google.com/detail/tailchrome/bhfeceecialgilpedkoflminjgcjljll) | [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tailchrome/) | [tesseras.org/tailchrome](https://tesseras.org/tailchrome/)

Tailchrome runs a full Tailscale node per browser profile, without touching system networking. Works in Chrome, Firefox, and other Chromium-family browsers (Brave, Edge, Vivaldi, Opera, plus Arc on macOS) with full feature parity. Tailnet traffic is routed through a local SOCKS5/HTTP proxy, so it works alongside (or without) the Tailscale system app.

<img width="1400" height="820" alt="Tailchrome live status, exit node, and split tunneling views" src="store-assets/readme-overview-v2.png" />

## Features

- **Per-profile isolation** — each browser profile gets its own independent Tailscale node and identity
- **Exit nodes** — route all browser traffic through any exit node on your tailnet, with a "Best available" recommendation that picks a nearby Mullvad location when one is available
- **Split-tunneling** — pick domains that bypass your exit node (handy for sites that flag VPN traffic), or restrict the exit node to only the domains you list
- **MagicDNS** — access devices by name, not IP
- **Subnet routing** — reach resources behind subnet routers
- **Profiles** — create and switch between multiple Tailscale identities
- **Custom coordination servers** — connect a browser profile to a self-hosted control server such as Headscale
- **Side panel** — opt in to keep the UI docked while you browse (Chrome side panel, Firefox sidebar)
- **Auto-connect on start** — optional toggle that brings the tailnet up when the browser launches
- **Shields Up** — block incoming connections for extra security

## How it works

The extension has two parts:

- A **browser extension** (Manifest V3, Chrome and Firefox) that manages proxy configuration and provides the popup UI
- A **native host** (Go, using `tsnet`) that runs the actual Tailscale node and exposes a local proxy

They communicate over the browser's native messaging protocol. See the [full documentation](docs/DOCUMENTATION.md) for details.

### Side panel mode

By default, clicking the Tailchrome toolbar icon opens a popup that dismisses on click-away. If you'd rather keep the UI visible while you browse, flip **Open as side panel** in the popup's quick settings:

- **Chrome:** the side panel opens on toolbar click and stays open until you close it. Chrome keeps the extension's service worker alive while the panel is visible, so peer status updates feel snappier.
- **Firefox:** the toolbar click opens Tailchrome in the sidebar. Flip the toggle from inside the sidebar to switch back to popup mode.

The same UI renders in either surface.

## Install

1. Get the extension from the [Chrome Web Store](https://chromewebstore.google.com/detail/tailchrome/bhfeceecialgilpedkoflminjgcjljll) (also installs in Brave, Edge, Vivaldi, Opera, and — on macOS — Arc) or [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tailchrome/)
2. Install the native helper with [Homebrew](#homebrew-macos-and-linux) on macOS/Linux, or from the [latest release](https://github.com/dantraynor/tailchrome/releases/latest) — **`tailchrome-helper-macos.pkg`** on macOS, **`tailchrome-helper-windows-x64.msi`** on Windows, or the **`.deb`/`.rpm`** package on Linux amd64. Linux ARM64 and per-user repair flows can also use the release's checksum-verifying **`tailchrome-install.sh`**.
3. Log in to your Tailscale account

### Homebrew (macOS and Linux)

Add this repository as a tap once:

```bash
brew tap dantraynor/tailchrome https://github.com/dantraynor/tailchrome
```

On macOS, install the signed helper package with
`brew install --cask dantraynor/tailchrome/tailchrome`.

To build the helper from source on Linux or macOS, run:

```bash
brew install --formula dantraynor/tailchrome/tailchrome
tailscale-browser-ext -install-now
```

The formula installs Go as a build dependency. Formula users must close their
browsers and repeat `tailscale-browser-ext -install-now` after each `brew upgrade`
to refresh the per-user runtime copy. See the
[Homebrew instructions](packaging/homebrew/README.md) for upgrades, repair,
and removal. The browser extension is installed separately.

### Platform installers

The platform release package is the primary installation path. The macOS
installer is platform-signed. A Windows installer is release-quality only when
the raw helper, embedded helper, and outer MSI pass the
[Windows code-signing policy](docs/WINDOWS_CODE_SIGNING_POLICY.md); older
releases may predate that gate. Linux packages are covered by the release
checksum and build-provenance attestation. If Tailchrome still cannot discover
the helper after the package is installed, the popup
offers a current-user registration repair for the browser that requested it.
On macOS, `/Applications/Tailchrome Helper.app` provides the same repair entry
point. The macOS/Linux fallback installer is pinned to one release version,
checks the downloaded helper before running it, and uses the helper's own
tested registration targets; see the
[Linux](packaging/linux/README.md) and [macOS](packaging/macos/README.md)
instructions.

Helper release differences do not disable the connection. Tailchrome keeps
using the capabilities the installed helper advertises and shows a
non-blocking release notice when versions differ. Helper diagnostic reports
are created only when you choose **Copy diagnostic report** or
**Export diagnostic report**; they remain local until you copy, save, or share
them.

Release artifacts are assembled and checksummed only after platform signing
and packaging. Windows publication is additionally gated by the
[Windows code-signing policy](docs/WINDOWS_CODE_SIGNING_POLICY.md) and the
[release security checklist](docs/RELEASE_CHECKLIST.md).

## Code signing policy

Tailchrome is applying to SignPath Foundation for Windows Authenticode signing.
Until the application is accepted and the release workflow produces a verified
test signature, Windows release notes continue to identify those artifacts as
unsigned. The public [Windows code-signing
policy](docs/WINDOWS_CODE_SIGNING_POLICY.md) defines who may submit and approve
signing requests, which builds are eligible, how signatures are verified, and
how a compromised or replaced publisher identity is handled.

For releases signed through the SignPath Foundation program:

> Free code signing provided by SignPath.io, certificate by SignPath Foundation

## Development

```
pnpm install --frozen-lockfile
make dev              # Chrome extension (watch mode)
make host             # Native host binary
```

PRs run CI (lint, typecheck, TypeScript and Go tests, browser tests,
packaging checks, and the Firefox review gate). A release tag assembles one
immutable helper candidate; the protected publication workflow publishes only
the cleared candidate bytes. Chrome Web Store and Firefox Add-ons submissions
remain separate gated jobs. See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for
full setup and build commands.

## Contributing

Bug reports and feature requests are welcome. Please open an issue before submitting a PR so we can discuss the approach. See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for guidelines.

## License

MIT
