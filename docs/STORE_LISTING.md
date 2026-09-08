# Tailchrome Store Listings

## Chrome Web Store

### Short Description (132 chars max)

Access your Tailscale tailnet directly from your browser. Per-profile VPN without touching system networking.

### Detailed Description

Tailchrome connects your browser to your Tailscale tailnet without installing a system-wide VPN. Each browser profile runs its own isolated Tailscale node, so you can be logged into different tailnets in different profiles.

**Key features:**
- Access devices on your tailnet by name or IP, directly from the browser
- Per-profile isolation: each Chrome profile gets its own Tailscale identity
- Exit nodes: route browser traffic through any exit node on your tailnet, with a "Best available" recommendation that picks a nearby Mullvad location when available
- Split-tunneling: choose domains that bypass your exit node (useful for sites that flag VPN traffic), or restrict the exit node to a specific set of domains
- MagicDNS: reach your devices by hostname
- Subnet routing: access resources behind subnet routers
- Custom coordination server: point your browser's node at a self-hosted control server (such as Headscale) instead of Tailscale's default
- Side panel mode: opt-in toggle keeps the Tailchrome UI docked next to your tabs instead of dismissing on click-away
- Auto-connect on start: optional toggle that brings your tailnet up automatically when the browser launches
- No system networking changes: only browser traffic is affected
- Shields Up mode for extra security
- Works in Chrome and other Chromium-family browsers (Brave, Edge, Vivaldi, Opera; Arc on macOS)

**How it works:**
Tailchrome uses a lightweight native helper app that runs a full Tailscale node for each browser profile. Your system networking stays untouched. Only traffic from the browser is routed through your tailnet.

**Getting started:**
1. Install the extension
2. Download and run the helper installer (one-time setup, ~30 seconds)
3. Log in to your Tailscale account
4. Toggle the switch to connect

**Privacy:** Tailchrome communicates only with your coordination server (Tailscale's by default, or a custom one you configure) and your tailnet peers. No data is sent to third parties. The extension requires the "proxy" permission to route browser traffic and "nativeMessaging" to communicate with the helper app.

### Category
Productivity

### Language
English


## Firefox AMO

### Summary (250 chars max)

Access your Tailscale tailnet directly from Firefox. Each browser profile runs its own isolated Tailscale node without affecting system networking. Supports exit nodes, MagicDNS, subnet routing, custom coordination servers, and a sidebar UI.

### Description

Tailchrome connects Firefox to your Tailscale tailnet without a system VPN. Each browser profile gets its own Tailscale identity, keeping your personal and work tailnets separate.

**Features:**
- Browse devices on your tailnet by name or IP
- Per-profile Tailscale isolation
- Exit nodes for routing through your tailnet, with a "Best available" recommendation that prefers nearby Mullvad locations when available
- Split-tunneling: choose domains that bypass an exit node, or restrict the exit node to specific domains only
- MagicDNS hostname resolution
- Subnet routing support
- Custom coordination server support for self-hosted control servers such as Headscale
- Optional sidebar mode keeps Tailchrome docked while you browse
- Auto-connect on start: optional toggle to bring the tailnet up automatically on browser launch
- Zero system networking changes
- Shields Up mode

**Setup:**
Install the extension, download the helper installer, and log in. The helper app is a small native program that runs a Tailscale node per browser profile. Setup takes about 30 seconds.

**How it works:**
A native messaging host runs locally and manages Tailscale connections per profile. Only Firefox traffic is routed through your tailnet. Your system networking is never modified.

**Open Source:**
Source code is available at https://github.com/dantraynor/tailchrome

### Categories
Privacy & Security, Other


## Store Media

Use this 1280x800 sequence for both Chrome Web Store and Firefox AMO:

1. `store-assets/screenshot-v2-1-overview.png` — the per-browser-node concept and connected dashboard
2. `store-assets/screenshot-v2-2-control.png` — the live connected control surface
3. `store-assets/screenshot-v2-3-profiles.png` — isolated Work and Personal profiles, including dark mode
4. `store-assets/screenshot-v2-4-exit-nodes.png` — recommended, device, and Mullvad exit routing
5. `store-assets/screenshot-v2-5-split-tunneling.png` — Bypass/Only domain rules

Chrome Web Store promotional images:

- `store-assets/promo-small-v2.png` — 440x280, text-free small promotional tile
- `store-assets/promo-marquee-v2.png` — 1400x560 marquee

The matching HTML compositions and shared `store-assets/campaign.css` are kept beside the PNGs. Product surfaces come from deterministic extension fixtures rather than hand-drawn UI, so refresh those captures when the popup changes materially.
