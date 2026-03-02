# Tailchrome

A Chrome extension that runs a full Tailscale node per browser profile, without touching system networking. Tailnet traffic is routed through a local SOCKS5/HTTP proxy using a PAC script.

## How it works

The extension has two parts:

- A **Chrome extension** (Manifest V3) that manages proxy configuration and provides the popup UI
- A **native host** (Go, using `tsnet`) that runs the actual Tailscale node and exposes a local proxy

They communicate over Chrome's native messaging protocol.

## Build

```
make all          # build everything
make extension    # extension only
make host         # native host only
make dev          # extension watch mode
```

The extension is built to `extension/dist/`. The native host binary goes to `dist/tailscale-browser-ext`.

## Install

1. Build the extension and native host with `make all`
2. Go to `chrome://extensions`, enable Developer Mode, and load `extension/dist/` as an unpacked extension
3. Copy the extension ID Chrome assigns
4. Install the native host:

```
./dist/tailscale-browser-ext --install=<extension-id>
```

Each browser profile gets its own independent Tailscale node.
