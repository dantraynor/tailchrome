# Tailchrome

Access your Tailscale network directly from Chrome. No system VPN required.

https://tesseras.org/tailchrome/ | [Chrome Web Store](https://chromewebstore.google.com/detail/tailchrome/bhfeceecialgilpedkoflminjgcjljll)

Tailchrome runs a full Tailscale node per browser profile, without touching system networking. Tailnet traffic is routed through a local SOCKS5/HTTP proxy using a PAC script, so it works alongside (or without) the Tailscale system app.

<p align="center">
  <img src="tailchrome-popup-full.png" alt="Tailchrome popup" width="300">
</p>

## Features

- **Per-profile isolation** — each Chrome profile gets its own independent Tailscale node and identity
- **Exit nodes** — route all browser traffic through any exit node on your tailnet
- **MagicDNS** — access devices by name, not IP
- **Subnet routing** — reach resources behind subnet routers
- **Taildrop** — send files to other devices on your tailnet
- **Profiles** — create and switch between multiple Tailscale identities

## How it works

The extension has two parts:

- A **Chrome extension** (Manifest V3) that manages proxy configuration and provides the popup UI
- A **native host** (Go, using `tsnet`) that runs the actual Tailscale node and exposes a local proxy

They communicate over Chrome's native messaging protocol.

## Install from the Chrome Web Store

1. [Install Tailchrome](https://chromewebstore.google.com/detail/tailchrome/bhfeceecialgilpedkoflminjgcjljll) from the Chrome Web Store
2. Click the extension icon and follow the prompts to install the native host
3. Log in to your Tailscale account

## Development

### Requirements

- Go 1.21+
- Node.js / npm
- macOS (native host currently targets Darwin)

### Build

```
make all          # build everything
make extension    # extension only
make host         # native host only
make dev          # extension watch mode
```

The extension is built to `extension/dist/`. The native host binary goes to `dist/tailscale-browser-ext`.

### Install

1. Build the extension and native host with `make all`
2. Go to `chrome://extensions`, enable Developer Mode, and load `extension/dist/` as an unpacked extension
3. Copy the extension ID Chrome assigns
4. Install the native host:

```
./dist/tailscale-browser-ext --install=<extension-id>
```

## Contributing

This project is still early. Bug reports and feature requests are welcome. Please open an issue first before submitting a PR so we can discuss the approach.

## License

MIT
