# Tailchrome

Access your Tailscale network directly from your browser. No system VPN required.
<img width="1400" height="560" alt="promo-marquee" src="https://github.com/user-attachments/assets/88f6953e-014c-4c35-aa44-d612786f6d17" />

https://tesseras.org/tailchrome/ | [Chrome Web Store](https://chromewebstore.google.com/detail/tailchrome/bhfeceecialgilpedkoflminjgcjljll)

Tailchrome runs a full Tailscale node per browser profile, without touching system networking. Tailnet traffic is routed through a local SOCKS5/HTTP proxy, so it works alongside (or without) the Tailscale system app.

<p align="center">
  <img src="tailchrome-popup-full.png" alt="Tailchrome popup" width="300">
</p>

## Features

- **Chrome and Firefox** — works in both browsers with full feature parity
- **Per-profile isolation** — each browser profile gets its own independent Tailscale node and identity
- **Exit nodes** — route all browser traffic through any exit node on your tailnet
- **MagicDNS** — access devices by name, not IP
- **Subnet routing** — reach resources behind subnet routers
- **Taildrop** — send files to other devices on your tailnet
- **Profiles** — create and switch between multiple Tailscale identities

## How it works

The extension has two parts:

- A **browser extension** (Manifest V3, Chrome and Firefox) that manages proxy configuration and provides the popup UI
- A **native host** (Go, using `tsnet`) that runs the actual Tailscale node and exposes a local proxy

They communicate over the browser's native messaging protocol.

## Install

### Chrome

1. [Install Tailchrome](https://chromewebstore.google.com/detail/tailchrome/bhfeceecialgilpedkoflminjgcjljll) from the Chrome Web Store
2. Click the extension icon and follow the prompts to install the native host
3. Log in to your Tailscale account

### Firefox

1. Install Tailchrome from [GitHub Releases](https://github.com/dantraynor/tailchrome/releases/latest) (Firefox addon coming to AMO soon)
2. Click the extension icon and follow the prompts to install the native host
3. Log in to your Tailscale account

## Development

### Requirements

- Go 1.21+
- Node.js / pnpm
- macOS (native host currently targets Darwin)

### Project Structure

```
packages/
  shared/     # Shared code (types, state management, UI, background logic)
  chrome/     # Chrome-specific build (manifest, proxy manager)
  firefox/    # Firefox-specific build (manifest, proxy manager)
host/         # Native messaging host (Go)
```

### Build

```
make all              # build everything
make extension        # both browser extensions
make extension-chrome # Chrome extension only
make extension-firefox # Firefox extension only
make host             # native host only
make dev              # Chrome extension watch mode
```

The Chrome extension is built to `packages/chrome/dist/`, Firefox to `packages/firefox/dist/`. The native host binary goes to `dist/tailscale-browser-ext`.

### Install for Development

1. Build the extension and native host with `make all`
2. **Chrome:** Go to `chrome://extensions`, enable Developer Mode, and load `packages/chrome/dist/` as an unpacked extension
3. **Firefox:** Go to `about:debugging#/runtime/this-firefox` and load `packages/firefox/dist/manifest.json` as a temporary addon
4. Install the native host by running the binary directly (it auto-installs for both browsers)

## Contributing

This project is still early. Bug reports and feature requests are welcome. Please open an issue first before submitting a PR so we can discuss the approach.

## License

MIT
