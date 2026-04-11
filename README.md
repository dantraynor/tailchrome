# Tailchrome

Access your Tailscale network directly from your browser. No system VPN required.

<img width="1400" height="560" alt="promo-marquee" src="https://github.com/user-attachments/assets/88f6953e-014c-4c35-aa44-d612786f6d17" />

[Chrome Web Store](https://chromewebstore.google.com/detail/tailchrome/bhfeceecialgilpedkoflminjgcjljll) | [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tailchrome/) | [tesseras.org/tailchrome](https://tesseras.org/tailchrome/)

Tailchrome runs a full Tailscale node per browser profile, without touching system networking. Works in both Chrome and Firefox with full feature parity. Tailnet traffic is routed through a local SOCKS5/HTTP proxy, so it works alongside (or without) the Tailscale system app.

<p align="center">
  <img src="store-assets/readme-popup.png" alt="Tailchrome popup" width="320">&nbsp;&nbsp;&nbsp;&nbsp;<img src="store-assets/readme-popup-exit-nodes.png" alt="Tailchrome exit node picker" width="320">
</p>

## Features

- **Per-profile isolation** — each browser profile gets its own independent Tailscale node and identity
- **Exit nodes** — route all browser traffic through any exit node on your tailnet (including Mullvad exit nodes)
- **MagicDNS** — access devices by name, not IP
- **Subnet routing** — reach resources behind subnet routers
- **Profiles** — create and switch between multiple Tailscale identities
- **Shields Up** — block incoming connections for extra security

## How it works

The extension has two parts:

- A **browser extension** (Manifest V3, Chrome and Firefox) that manages proxy configuration and provides the popup UI
- A **native host** (Go, using `tsnet`) that runs the actual Tailscale node and exposes a local proxy

They communicate over the browser's native messaging protocol. See the [full documentation](docs/DOCUMENTATION.md) for details.

## Install

1. Get the extension from the [Chrome Web Store](https://chromewebstore.google.com/detail/tailchrome/bhfeceecialgilpedkoflminjgcjljll) or [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tailchrome/)
2. Install the native helper from the [latest release](https://github.com/dantraynor/tailchrome/releases/latest) — on macOS, download and open **`tailchrome-helper-macos.pkg`**; on other platforms, download the binary and run it
3. Log in to your Tailscale account

## Development

```
pnpm install --frozen-lockfile
make dev              # Chrome extension (watch mode)
make host             # Native host binary
```

PRs run CI (lint, typecheck, tests, Firefox review gate). Tagged releases build all artifacts and publish to the Chrome Web Store and Firefox Add-ons. See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for full setup and build commands.

## Contributing

Bug reports and feature requests are welcome. Please open an issue before submitting a PR so we can discuss the approach. See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for guidelines.

## License

MIT
