# Tailchrome -- Complete Technical Documentation

> Access your Tailscale network directly from your browser. No system VPN required.

**Version:** 0.1.6 (native host) | Manifest V3
**Browsers:** Chrome, Firefox
**Platforms:** macOS (amd64, arm64), Linux (amd64), Windows (amd64)
**License:** MIT
**Website:** [https://tesseras.org/tailchrome/](https://tesseras.org/tailchrome/)
**Chrome Web Store:** [https://chromewebstore.google.com/detail/tailchrome/bhfeceecialgilpedkoflminjgcjljll](https://chromewebstore.google.com/detail/tailchrome/bhfeceecialgilpedkoflminjgcjljll)
**Privacy Policy:** [docs/privacy-policy.md](privacy-policy.md)

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Feature Set](#feature-set)
4. [Native Messaging Protocol](#native-messaging-protocol)
5. [Extension Internals](#extension-internals)
6. [Native Host Internals](#native-host-internals)
7. [Proxy System](#proxy-system)
8. [State Management](#state-management)
9. [Popup UI](#popup-ui)
10. [Browser Differences](#browser-differences)
11. [Installation and Setup](#installation-and-setup)
12. [Project Structure](#project-structure)
13. [Build System](#build-system)
14. [CI/CD Pipeline](#cicd-pipeline)
15. [Test Infrastructure](#test-infrastructure)
16. [Configuration Reference](#configuration-reference)
17. [Security Model](#security-model)
18. [Data Handling and Privacy](#data-handling-and-privacy)
19. [Store Listings](#store-listings)
20. [Contributing](#contributing)

---

## Overview

Tailchrome is a browser extension that runs a full Tailscale node per browser profile, without touching system networking. It consists of two components:

- A **browser extension** (TypeScript, Manifest V3) that manages proxy configuration and provides a popup UI.
- A **native messaging host** (Go, using `tsnet`) that runs the actual Tailscale node and exposes a local SOCKS5/HTTP proxy.

The two communicate over the browser's native messaging protocol. Tailnet traffic from the browser is routed through the local proxy, so Tailchrome works alongside (or without) the Tailscale system app.

Each browser profile gets its own isolated Tailscale identity, meaning you can be logged into different tailnets in different Chrome/Firefox profiles simultaneously.

---

## Architecture

```
+---------------------------------------------+
|  POPUP UI                                    |
|  (popup.ts, views/*.ts, components/*.ts)     |
|  - Connected view with peer list             |
|  - Exit node picker                          |
|  - Profile switcher                          |
|  - Disconnected / NeedsLogin / NeedsInstall  |
+-------------------+--------------------------+
                    | chrome.runtime.Port ("popup")
                    | PopupMessage / BackgroundMessage
                    v
+---------------------------------------------+
|  BACKGROUND SERVICE WORKER                   |
|  (background.ts)                             |
|  - StateStore (TailscaleState)               |
|  - NativeHostConnection (auto-reconnect)     |
|  - BadgeManager (icon/text updates)          |
|  - ProxyManager (Chrome PAC / Firefox API)   |
|  - Context menu handlers                     |
|  - Keepalive timer                           |
+-------------------+--------------------------+
                    | chrome.runtime.connectNative()
                    | 4-byte LE length + JSON
                    | NativeRequest / NativeReply
                    v
+---------------------------------------------+
|  NATIVE HOST (Go)                            |
|  - tsnet.Server per browser profile          |
|  - IPN bus watcher (real-time state)         |
|  - SOCKS5 + HTTP proxy on 127.0.0.1:0       |
|  - Tailscale web client at 100.100.100.100   |
|  - Profile management (create/switch/delete) |
|  - Taildrop file sender                      |
+---------------------------------------------+
                    |
                    | WireGuard / DERP / Control
                    v
              Tailscale Network
```

### Data Flow

1. **Startup:** Extension opens native messaging connection. Host starts, binds a SOCKS5/HTTP proxy on a random local port, and sends `procRunning` with the port number and version.
2. **Init:** Extension sends `init` with a browser-profile UUID (`initID`). Host creates (or reuses) a `tsnet.Server` with state stored at `~/.config/tailscale-browser-ext/<initID>/`.
3. **State watching:** Host starts a goroutine (`watchIPNBus`) that monitors the IPN notification bus for state, prefs, netmap, browse-to-URL, and health changes. On any change, it fetches full status and sends a `StatusUpdate` to the extension.
4. **Proxy routing:** The background service worker receives the status, passes it to the `ProxyManager`, which configures browser-level proxy rules (PAC script on Chrome, `proxy.onRequest` on Firefox).
5. **Popup:** When the user opens the popup, it connects via a `chrome.runtime.Port` named `"popup"`. The background immediately sends current `TailscaleState`. User actions dispatch `BackgroundMessage` types which the background translates to `NativeRequest` commands.

---

## Feature Set

### Core Networking

- **Tailnet access** -- browse devices on your tailnet by IP or MagicDNS name, directly from the browser
- **Per-profile isolation** -- each browser profile gets its own independent Tailscale node and identity
- **Exit nodes** -- route all browser traffic through any exit node on your tailnet, with suggested-node optimization
- **MagicDNS** -- resolve tailnet device names automatically
- **Subnet routing** -- access resources behind subnet routers (auto-detected from peer info)
- **Allow LAN access** -- when using an exit node, optionally allow local network access

### Device Management

- **Peer list** -- online/offline grouping with search, incremental DOM updates
- **Copy IP / Copy DNS** -- one-click clipboard copy of any peer's Tailscale IP or DNS name
- **Open web interface** -- launch peer's web UI in a new tab
- **SSH access** -- open SSH-capable peers via the Tailscale web SSH client (`http://100.100.100.100/ssh/<hostname>`)
- **Custom URLs** -- configure per-device custom port/URL for quick open actions

### File Transfer

- **Taildrop** -- send files to other devices on your tailnet
- **Context menu** -- right-click "Send page URL to Tailscale device" to share the current page URL as a text file via Taildrop
- **Progress reporting** -- file send progress displayed as persistent toast notifications

### Identity & Configuration

- **Profiles** -- create, switch between, and delete multiple Tailscale profiles (identities)
- **Shields Up** -- toggle to block all incoming connections
- **Run as Exit Node** -- advertise this browser node as an exit node
- **Login / Logout** -- authenticate with Tailscale (validates login URLs against allowed origins)
- **Health warnings** -- collapsible banner displaying Tailscale health warnings

### UX

- **Badge status** -- extension icon reflects online/offline/warning state with text badge for active exit node
- **Auto-reconnect** -- exponential backoff reconnection to native host (1s base, 30s max)
- **Exit node persistence** -- last-selected exit node restored automatically after reconnection
- **Toast notifications** -- in-popup toasts for operations (file send, errors, suggestions)
- **Keyboard navigation** -- peer list supports arrow key navigation
- **Platform-aware** -- detects macOS for platform-specific UI hints

---

## Native Messaging Protocol

Communication uses the Chrome native messaging wire format: a **4-byte little-endian length prefix** followed by a **JSON payload**. Maximum message size is **1 MB** (Chrome-enforced limit).

### Commands (Extension -> Host)


| Command             | Fields                                          | Description                                      |
| ------------------- | ----------------------------------------------- | ------------------------------------------------ |
| `init`              | `initID: string`                                | Initialize tsnet.Server for browser profile UUID |
| `up`                | --                                              | Set `WantRunning=true`                           |
| `down`              | --                                              | Set `WantRunning=false`                          |
| `get-status`        | --                                              | Request full status update                       |
| `ping`              | --                                              | Keepalive; host replies with `pong`              |
| `set-exit-node`     | `nodeID: string`                                | Set exit node (empty string to clear)            |
| `set-prefs`         | `prefs: Partial<PrefsView>`                     | Apply partial preference changes                 |
| `list-profiles`     | --                                              | List all Tailscale profiles                      |
| `switch-profile`    | `profileID: string`                             | Switch to a different profile                    |
| `new-profile`       | --                                              | Create and switch to a new empty profile         |
| `delete-profile`    | `profileID: string`                             | Delete a profile                                 |
| `send-file`         | `nodeID, fileName, fileData (base64), fileSize` | Send file via Taildrop                           |
| `suggest-exit-node` | --                                              | Request optimized exit node suggestion           |
| `logout`            | --                                              | Log out of current Tailscale account             |


### Replies (Host -> Extension)


| Reply Field          | When Sent                           | Payload                                         |
| -------------------- | ----------------------------------- | ----------------------------------------------- |
| `procRunning`        | Immediately on host startup         | `{ port, pid, version, error? }`                |
| `init`               | After `init` command                | `{ error? }`                                    |
| `pong`               | After `ping`                        | `{}`                                            |
| `status`             | After state changes or `get-status` | Full `StatusUpdate` object                      |
| `profiles`           | After profile commands              | `{ current, profiles[] }`                       |
| `exitNodeSuggestion` | After `suggest-exit-node`           | `{ id, hostname, location? }`                   |
| `fileSendProgress`   | During file send                    | `{ targetNodeID, name, percent, done, error? }` |
| `error`              | On command failure                  | `{ cmd, message }`                              |


### StatusUpdate Structure

```typescript
interface StatusUpdate {
  backendState: "NoState" | "NeedsMachineAuth" | "NeedsLogin" |
                "InUseOtherUser" | "Stopped" | "Starting" | "Running";
  running: boolean;
  tailnet: string | null;
  magicDNSSuffix: string;
  selfNode: SelfNode | null;
  needsLogin: boolean;
  browseToURL: string;              // Login URL from control plane
  exitNode: ExitNodeInfo | null;
  peers: PeerInfo[];
  prefs: TailscalePrefs | null;
  health: string[];
  error: string | null;
}
```

Each `PeerInfo` includes: `id`, `hostname`, `dnsName`, `tailscaleIPs[]`, `os`, `online`, `active`, `exitNode`, `exitNodeOption`, `isSubnetRouter`, `subnets[]`, `tags[]`, `rxBytes`, `txBytes`, `lastSeen`, `lastHandshake`, `location?`, `taildropTarget`, `sshHost`, `userId`, `userName`, `userLoginName`, `userProfilePicURL`.

---

## Extension Internals

### Packages

The extension is a **pnpm monorepo** with two packages:


| Package                 | Path                  | Purpose                                                                               |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------- |
| `@tailchrome/extension` | `packages/extension/` | WXT app for Chrome/Firefox packaging, browser-specific proxy managers, entrypoints    |
| `@tailchrome/shared`    | `packages/shared/`    | Shared TypeScript: types, state management, popup logic, background core, proxy utils |


The shared package contains all the platform-agnostic logic. The extension package contains browser-specific entrypoints, proxy managers, and WXT configuration.

### Key Modules

`**packages/shared/src/background/`**


| File               | Lines | Purpose                                                                                                         |
| ------------------ | ----- | --------------------------------------------------------------------------------------------------------------- |
| `background.ts`    | 489   | Core service worker: native host management, popup communication, state subscriptions, context menus, keepalive |
| `native-host.ts`   | 165   | `NativeHostConnection` class with exponential backoff reconnection (1s-30s), profile UUID generation            |
| `state-store.ts`   | 86    | Redux-like `StateStore` with `subscribe()`, `update()`, `applyStatusUpdate()`                                   |
| `badge-manager.ts` | 106   | Extension icon/badge updates for online, offline, warning, and exit-node states                                 |
| `proxy-utils.ts`   | 90    | IP-to-number conversion, CIDR parsing, MagicDNS suffix sanitization, subnet collection, `shouldProxyState()`    |
| `timer-service.ts` | 55    | Abstract `TimerService` interface; `DefaultTimerService` wraps native `setInterval`/`clearInterval`             |


`**packages/shared/src/popup/**`


| File             | Lines | Purpose                                                                         |
| ---------------- | ----- | ------------------------------------------------------------------------------- |
| `popup.ts`       | 182   | Popup initialization, view routing based on state, sub-view management          |
| `utils.ts`       | 155   | HTML escaping, clipboard, toast notifications, keyboard nav, platform detection |
| `custom-urls.ts` | 49    | Per-device custom port/URL storage using `chrome.storage.local`                 |
| `icons.ts`       | --    | SVG icon definitions (Tailscale logo, chevrons, warning, lock, plug, etc.)      |


`**packages/shared/src/popup/views/**`


| File                 | Lines | Purpose                                                                            |
| -------------------- | ----- | ---------------------------------------------------------------------------------- |
| `connected.ts`       | 425   | Main connected view: status bar, quick settings, peer search/list, footer          |
| `exit-nodes.ts`      | 322   | Exit node picker: search, suggested node, country flags, online/offline indicators |
| `profiles.ts`        | 132   | Profile switcher: create, switch, delete actions                                   |
| `disconnected.ts`    | 142   | Error recovery view with context-specific hints                                    |
| `needs-login.ts`     | 54    | Login prompt when `backendState === "NeedsLogin"`                                  |
| `needs-install.ts`   | 10    | Native host installation guide                                                     |
| `needs-update.ts`    | 10    | Host version mismatch guide                                                        |
| `install-helpers.ts` | --    | Shared helpers for install/update views                                            |


`**packages/shared/src/popup/components/**`


| File                 | Lines | Purpose                                                               |
| -------------------- | ----- | --------------------------------------------------------------------- |
| `peer-list.ts`       | 160   | Peer list with online/offline grouping, incremental DOM updates       |
| `peer-item.ts`       | 322   | Peer row: copy IP/DNS, open web UI, SSH, file send, custom URL editor |
| `header.ts`          | 73    | Logo + toggle switch component                                        |
| `health-warnings.ts` | 89    | Collapsible health warning banner                                     |
| `toggle-switch.ts`   | 36    | Reusable toggle component                                             |


`**packages/extension/src/background/**`


| File                       | Purpose                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| `chrome-proxy-manager.ts`  | PAC script generation for Chrome                                        |
| `firefox-proxy-manager.ts` | `proxy.onRequest` listener for Firefox with session storage persistence |


`**packages/extension/entrypoints/**`


| File               | Purpose                                               |
| ------------------ | ----------------------------------------------------- |
| `background.ts`    | Routes to Chrome or Firefox background initialization |
| `popup/main.ts`    | Popup entry; imports shared popup module              |
| `popup/index.html` | Popup HTML shell                                      |
| `popup/style.css`  | Popup styles                                          |


### Constants

Defined in `packages/shared/src/constants.ts`:


| Constant                | Value                               | Purpose                                                   |
| ----------------------- | ----------------------------------- | --------------------------------------------------------- |
| `TAILSCALE_SERVICE_IP`  | `100.100.100.100`                   | Tailscale service/web client address                      |
| `KEEPALIVE_INTERVAL_MS` | `25000`                             | Ping interval to keep service worker alive                |
| `RECONNECT_BASE_MS`     | `1000`                              | Reconnection backoff base                                 |
| `RECONNECT_MAX_MS`      | `30000`                             | Reconnection backoff ceiling                              |
| `ADMIN_URL`             | `https://login.tailscale.com/admin` | Tailscale admin console                                   |
| `EXPECTED_HOST_VERSION` | `0.1.6`                             | Expected native host version (major.minor match required) |


---

## Native Host Internals

The native host is a Go binary at `host/` using `tailscale.com/tsnet` v1.94.2.

### Files


| File           | Lines | Purpose                                                                                                                  |
| -------------- | ----- | ------------------------------------------------------------------------------------------------------------------------ |
| `main.go`      | 118   | Entry point: `--install`, `--uninstall`, `--version` flags; auto-install for terminal invocation; native messaging mode  |
| `host.go`      | 432   | `Host` struct: message read loop, request dispatch, `init`/`up`/`down`/`get-status`/`ping`/`set-prefs`/`logout` handlers |
| `protocol.go`  | 156   | Wire protocol types: `Request`, `Reply`, `StatusUpdate`, `PeerInfo`, `PrefsView`, `ProfileInfo`, etc.                    |
| `status.go`    | 173   | IPN bus watcher goroutine, full status refresh, `buildStatusUpdate()` from `ipnstate.Status`                             |
| `proxy.go`     | 162   | SOCKS5 + HTTP multiplexed proxy on `127.0.0.1:0`, web client routing for `100.100.100.100`, HTTPS CONNECT tunneling      |
| `profiles.go`  | 103   | Profile management: list, switch, create, delete via `tsnet` local client                                                |
| `taildrop.go`  | 134   | File send via Taildrop `PushFile` API with progress-tracking `io.Reader` (reports every ~10%)                            |
| `install.go`   | 196   | Native host manifest installation/uninstallation, binary self-copy to install dir                                        |
| `install_*.go` | --    | Platform-specific manifest directory paths (darwin, linux, windows)                                                      |
| `peers.go`     | --    | `extractPeers()` and `peerStatusToPeerInfo()` converters from `ipnstate` types                                           |
| `exitnode.go`  | --    | `handleSetExitNode()`, `handleSuggestExitNode()` handlers                                                                |


### Lifecycle

1. **Browser launches the host** via native messaging (stdin/stdout). Not a terminal -- goes directly to messaging mode.
2. **Proxy starts** on `127.0.0.1:0`. The port is sent back to the extension via `procRunning`.
3. **Extension sends `init`** with the browser profile UUID. Host creates a `tsnet.Server` at `~/.config/tailscale-browser-ext/<UUID>/` and starts it.
4. **IPN bus watcher** begins monitoring state, prefs, netmap, browse-to-URL, and health changes. Each change triggers a full `StatusUpdate` reply.
5. **Host reads commands** in a loop from stdin, dispatches to handlers, and writes replies to stdout.
6. **On stdin EOF** (browser closed), the host exits.

### Proxy Architecture

The proxy uses Tailscale's `proxymux.SplitSOCKSAndHTTP()` to multiplex a single listener:

- **SOCKS5 traffic** is handled by `tailscale.com/net/socks5`, dialing through `tsnet.Server.Dial()`.
- **HTTP traffic** is handled by an `httputil.ReverseProxy` that also dials through tsnet.
- **Requests to `100.100.100.100`** are routed to the Tailscale web client (`web.Server` in `ManageServerMode`), with a `Sec-Tailscale: browser-ext` header for CSRF protection.
- **HTTPS CONNECT** requests are hijacked for bidirectional tunneling through tsnet.

### Auto-Installation

When the host binary is run in a terminal (detected via `term.IsTerminal`), it auto-detects installed browsers and installs native messaging manifests for Chrome and/or Firefox. The binary copies itself to `~/.local/share/tailscale-browser-ext/` (or platform equivalent) and writes JSON manifests to the browser's native messaging host directory.

---

## Proxy System

### Chrome: PAC Script

Chrome uses a dynamically generated PAC (Proxy Auto-Config) script set via `chrome.proxy.settings.set()`. The PAC script routes traffic based on:

1. **Tailscale service IP** (`100.100.100.100`) -> proxy
2. **CGNAT range** (`100.64.0.0/10`) -> proxy (all Tailscale IPs)
3. **MagicDNS suffix** (e.g., `*.ts.net`) -> proxy
4. **Subnet routes** (from subnet router peers) -> proxy via `isInNet()` checks
5. **Exit node active** -> all traffic through proxy
6. **Otherwise** -> `DIRECT`

The proxy target is `SOCKS5 127.0.0.1:<port>`.

PAC script regeneration is skipped if proxy-relevant fields haven't changed (keyed on `port:suffix:exitNode:subnets`).

On service worker suspension, `chrome.proxy.settings.set({ mode: "direct" })` is called to prevent stale routing.

### Firefox: proxy.onRequest

Firefox uses the `browser.proxy.onRequest` API with an event listener that evaluates each request URL:

1. Same routing logic as Chrome (service IP, CGNAT, MagicDNS, subnets, exit node)
2. Returns `{ type: "socks", host: "127.0.0.1", port, proxyDNS: true }` or `{ type: "direct" }`
3. IP matching uses numeric comparison (`ipToNum()`) instead of PAC's `isInNet()`

**Session storage persistence:** Firefox suspends background event pages aggressively. The proxy config (port, suffix, exit node state, subnet ranges) is persisted to `browser.storage.session` under the key `"proxyConfig"`. On wake, the listener returns a `Promise` that waits for both storage restoration and native host reconnection before resolving proxy decisions.

---

## State Management

### StateStore

`StateStore` (`packages/shared/src/background/state-store.ts`) is a minimal Redux-like store:

```typescript
interface TailscaleState {
  stateVersion: number;        // Monotonically increasing counter
  hostConnected: boolean;
  initialized: boolean;
  proxyPort: number | null;
  proxyEnabled: boolean;
  backendState: BackendState;
  tailnet: string | null;
  selfNode: SelfNode | null;
  peers: PeerInfo[];
  exitNode: ExitNodeInfo | null;
  magicDNSSuffix: string | null;
  browseToURL: string | null;
  prefs: TailscalePrefs | null;
  health: string[];
  currentProfile: ProfileInfo | null;
  profiles: ProfileInfo[];
  exitNodeSuggestion: ExitNodeSuggestion | null;
  error: string | null;
  installError: boolean;
  hostVersion: string | null;
  hostVersionMismatch: boolean;
  reconnecting: boolean;
}
```

- `update(partial)` merges fields and increments `stateVersion`
- `applyStatusUpdate(status)` maps a `StatusUpdate` from the host into state fields
- `subscribe(callback)` registers a listener called on every state change
- Listeners receive the full state; ProxyManager, BadgeManager, and popup broadcast all subscribe

### Message Types

**PopupMessage** (background -> popup):

- `{ type: "state", state: TailscaleState }` -- full state push
- `{ type: "toast", message, level: "info"|"error", persistent? }` -- notification

**BackgroundMessage** (popup -> background):

- `toggle`, `login`, `logout`, `set-exit-node`, `clear-exit-node`, `set-pref`, `switch-profile`, `new-profile`, `delete-profile`, `send-file`, `suggest-exit-node`, `open-admin`, `open-web-client`

---

## Popup UI

The popup is a vanilla TypeScript UI (no framework) rendered into the extension popup HTML. Views are functions that return DOM elements.

### View Routing

`popup.ts` routes to views based on `TailscaleState`:


| Condition                       | View            |
| ------------------------------- | --------------- |
| `installError`                  | `needs-install` |
| `hostVersionMismatch`           | `needs-update`  |
| `!hostConnected`                | `disconnected`  |
| `backendState === "NeedsLogin"` | `needs-login`   |
| `backendState === "Running"`    | `connected`     |
| Everything else                 | `disconnected`  |


### Connected View Layout

```
+----------------------------------+
| [Tailscale logo]  [Toggle ON/OFF]|
+----------------------------------+
| [Health warning banner]          |
+----------------------------------+
| Status: Connected to <tailnet>   |
| IP: 100.x.y.z                   |
+----------------------------------+
| Quick Settings:                  |
|   Exit node: [current / None]  >|
|   Shields up           [toggle]  |
|   Run as exit node     [toggle]  |
|   Use Tailscale DNS    [toggle]  |
|   Allow LAN access     [toggle]  |
|   Profile: [name]              > |
+----------------------------------+
| [Search peers...]                |
+----------------------------------+
| ONLINE (3)                       |
|   > laptop  100.10.1.1  linux    |
|   > server  100.10.1.2  linux    |
|   > phone   100.10.1.3  android  |
| OFFLINE (1)                      |
|   > desktop 100.10.1.4  windows  |
+----------------------------------+
| [Admin console]  [Settings]      |
+----------------------------------+
```

Each peer item expands to show: Copy IP, Copy DNS, Open, SSH (if capable), Send File (if Taildrop target), and a custom URL editor.

---

## Browser Differences


| Feature           | Chrome                                                | Firefox                                      |
| ----------------- | ----------------------------------------------------- | -------------------------------------------- |
| Manifest version  | V3                                                    | V3                                           |
| Proxy mechanism   | `chrome.proxy.settings` (PAC script)                  | `browser.proxy.onRequest` (listener)         |
| Background type   | Service worker (persistent with keepalive)            | Event page (suspended aggressively)          |
| Keepalive         | `setInterval` ping every 25s                          | `browser.alarms` every 25s                   |
| State persistence | Not needed (service worker stays alive)               | Session storage for proxy config restoration |
| Native host ID    | `com.tailscale.browserext.chrome`                     | `com.tailscale.browserext.firefox`           |
| Permissions       | `proxy`, `storage`, `nativeMessaging`, `contextMenus` | Same + `alarms`                              |
| Min version       | --                                                    | Firefox 140+                                 |
| Distribution      | Chrome Web Store                                      | GitHub Releases / AMO (pending)              |
| Extension ID      | `bhfeceecialgilpedkoflminjgcjljll` (CWS)              | `tailchrome@tesseras.org` (gecko)            |


### Firefox-Specific Behaviors

- **Alarms keepalive:** Firefox suspends event pages after ~30s of inactivity. A `browser.alarms` alarm fires every 25s to send a keepalive ping and prevent suspension.
- **Proxy listener registration:** The `proxy.onRequest` listener is registered at extension load and persists across suspensions. On wake, it returns a `Promise` that waits for session storage restoration and native host reconnection.
- **Session storage:** Proxy config is persisted to `browser.storage.session` so that routing decisions can be made even before the native host reconnects after a suspension.
- **Data collection disclosure:** Firefox AMO requires explicit data collection permissions declared in the manifest via `gecko.data_collection_permissions`.

---

## Installation and Setup

### End User Installation

**Chrome:**

1. Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/tailchrome/bhfeceecialgilpedkoflminjgcjljll)
2. Click the extension icon -- follow prompts to install the native host
3. Log in to your Tailscale account

**Firefox:**

1. Install from [GitHub Releases](https://github.com/dantraynor/tailchrome/releases/latest)
2. Click the extension icon -- follow prompts to install the native host from GitHub Releases
3. Log in to your Tailscale account

### Native Host Installation

The native host binary auto-installs when run in a terminal:

- Detects installed browsers (Chrome and/or Firefox)
- Copies itself to `~/.local/share/tailscale-browser-ext/` (Linux), `~/Library/Application Support/tailscale-browser-ext/` (macOS), or `%LOCALAPPDATA%\tailscale-browser-ext\` (Windows)
- Writes native messaging manifest JSON files to browser-specific directories
- Manual install: `./tailscale-browser-ext --install C<extensionID>` or `--install F<extensionID>`
- Uninstall: `./tailscale-browser-ext --uninstall`

### State Directory

Per-profile Tailscale state is stored at:

```
~/.config/tailscale-browser-ext/<browser-profile-UUID>/
```

Each browser profile generates a UUID on first connection, stored in `chrome.storage.local` as `profileId`.

---

## Project Structure

```
tailchrome/
+-- packages/
|   +-- extension/                    # WXT app (browser-specific)
|   |   +-- entrypoints/
|   |   |   +-- background.ts        # Background entry (routes to chrome/firefox)
|   |   |   +-- popup/               # Popup HTML, CSS, entry
|   |   +-- src/background/
|   |   |   +-- chrome-proxy-manager.ts
|   |   |   +-- firefox-proxy-manager.ts
|   |   +-- config/
|   |   |   +-- firefox-disclosure.ts # AMO data collection declaration
|   |   +-- public/                   # Icons (online/offline/warning states)
|   |   +-- wxt.config.ts            # WXT manifest & build config
|   |   +-- package.json
|   |
|   +-- shared/                       # Platform-agnostic code
|       +-- src/
|       |   +-- types.ts              # All TypeScript type definitions
|       |   +-- constants.ts          # Configuration constants
|       |   +-- background/           # Service worker core logic
|       |   |   +-- background.ts     # Main background initialization
|       |   |   +-- native-host.ts    # Native host connection manager
|       |   |   +-- state-store.ts    # State management
|       |   |   +-- badge-manager.ts  # Icon/badge updates
|       |   |   +-- proxy-utils.ts    # IP/CIDR/DNS utilities
|       |   |   +-- timer-service.ts  # Timer abstraction
|       |   +-- popup/                # Popup UI views & components
|       |   |   +-- popup.ts          # View router
|       |   |   +-- utils.ts
|       |   |   +-- custom-urls.ts
|       |   |   +-- icons.ts
|       |   |   +-- views/
|       |   |   |   +-- connected.ts      # Main connected view
|       |   |   |   +-- exit-nodes.ts     # Exit node picker
|       |   |   |   +-- profiles.ts       # Profile switcher
|       |   |   |   +-- disconnected.ts   # Error recovery view
|       |   |   |   +-- needs-login.ts    # Login view
|       |   |   |   +-- needs-install.ts  # Install guide view
|       |   |   |   +-- needs-update.ts   # Update guide view
|       |   |   |   +-- install-helpers.ts
|       |   |   +-- components/
|       |   |   |   +-- peer-list.ts
|       |   |   |   +-- peer-item.ts
|       |   |   |   +-- header.ts
|       |   |   |   +-- health-warnings.ts
|       |   |   |   +-- toggle-switch.ts
|       |   +-- __test__/             # Test fixtures and mocks
|       +-- package.json
|
+-- host/                             # Native messaging host (Go)
|   +-- main.go                       # Entry point
|   +-- host.go                       # Host struct, message loop, handlers
|   +-- protocol.go                   # Wire protocol types
|   +-- status.go                     # IPN bus watcher
|   +-- proxy.go                      # SOCKS5/HTTP proxy
|   +-- profiles.go                   # Profile management
|   +-- taildrop.go                   # File transfer
|   +-- install.go                    # Manifest installation
|   +-- install_darwin.go             # macOS paths
|   +-- install_linux.go              # Linux paths
|   +-- install_windows.go            # Windows paths + registry
|   +-- peers.go                      # Peer info extraction
|   +-- exitnode.go                   # Exit node handlers
|   +-- go.mod / go.sum
|
+-- config/
|   +-- extension-ids.json            # Extension & native host IDs
|
+-- scripts/                          # Build/validation scripts
+-- store-assets/                     # Store listing images
+-- docs/
|   +-- privacy-policy.md
|   +-- firefox-amo-launch.md
|   +-- firefox-amo-review-notes.md
|   +-- firefox-smoke-test.md
|   +-- DOCUMENTATION.md              # This file
|   +-- CONTRIBUTING.md
|   +-- SOURCE_CODE_REVIEW.md         # Firefox AMO reviewer guide
|   +-- STORE_LISTING.md              # Chrome/Firefox store descriptions
|   +-- SECURITY.md
|   +-- CODE_OF_CONDUCT.md
|
+-- .github/workflows/
|   +-- ci.yml                        # PR checks
|   +-- release.yml                   # Tagged release builds
|   +-- publish.yml                   # Store submission
|
+-- Makefile                          # Top-level build targets
+-- package.json                      # Root workspace scripts
+-- pnpm-workspace.yaml               # Monorepo config
+-- tsconfig.base.json                # Shared TS config
+-- README.md
+-- LICENSE                           # MIT
```

---

## Build System

### Prerequisites

- Go 1.25+ (per `host/go.mod`)
- Node.js 22+
- pnpm (via corepack)
- Desktop Chrome or Firefox for testing

### Commands


| Command                           | Description                                                        |
| --------------------------------- | ------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`  | Install JS dependencies                                            |
| `pnpm build:chrome`               | Build Chrome extension via WXT                                     |
| `pnpm build:firefox`              | Build Firefox extension via WXT                                    |
| `pnpm zip:chrome`                 | Create `chrome.zip` for distribution                               |
| `pnpm zip:firefox`                | Create `firefox.zip` + `firefox-sources.zip`                       |
| `pnpm lint:firefox`               | Validate Firefox extension with web-ext lint                       |
| `pnpm review:firefox`             | Full Firefox review gate (build + lint + zip + publish validation) |
| `pnpm typecheck`                  | Run TypeScript type checking                                       |
| `pnpm test`                       | Run all tests (vitest)                                             |
| `pnpm validate:ids`               | Validate extension ID consistency                                  |
| `pnpm validate:release-tag <tag>` | Validate release tag format                                        |
| `make host`                       | Build native host for current platform                             |
| `make host-all`                   | Build host binaries for all platforms                              |
| `make dev`                        | Chrome watch mode via WXT                                          |
| `make all`                        | Build extension + host                                             |
| `make clean`                      | Clean all build outputs                                            |


### Build Outputs


| Output              | Location                                         |
| ------------------- | ------------------------------------------------ |
| Chrome extension    | `packages/extension/.output/chrome-mv3/`         |
| Firefox extension   | `packages/extension/.output/firefox-mv3/`        |
| Chrome ZIP          | `packages/extension/.output/chrome.zip`          |
| Firefox ZIP         | `packages/extension/.output/firefox.zip`         |
| Firefox sources ZIP | `packages/extension/.output/firefox-sources.zip` |
| Host binary         | `dist/tailscale-browser-ext`                     |
| Host cross-compile  | `dist/tailscale-browser-ext-{os}-{arch}`         |


### WXT Configuration

WXT (`packages/extension/wxt.config.ts`) handles:

- Manifest V3 generation for Chrome and Firefox
- Icon definitions (online, offline, warning states at 16/32/48/128px)
- Chrome extension key for stable development ID
- Firefox gecko settings (addon ID, `strict_min_version: "140.0"`, data collection permissions)
- Source ZIP configuration for AMO review (allowlisted paths only)
- Vite alias `@tailchrome/shared` -> `packages/shared/src`

---

## CI/CD Pipeline

### CI (`ci.yml`) -- Runs on Pull Requests

Four parallel jobs:

1. **extension-tests** -- `pnpm validate:ids`, `pnpm typecheck`, `pnpm test`
2. **build-chrome** -- `pnpm build:chrome`, uploads `chrome-build` artifact
3. **review-firefox** -- `pnpm review:firefox` (build + lint + zip + publish gate), uploads `firefox-build` artifact
4. **host-build** -- `make host-all`, uploads host binaries for all 4 platforms

### Release (`release.yml`) -- Runs on `v`* Tags or Manual Dispatch

Single job that:

1. Validates extension IDs and release tag
2. Builds `chrome.zip`, `firefox.zip`, `firefox-sources.zip`
3. Builds host binaries for all platforms
4. **Verifies Firefox source ZIP**: extracts sources, rebuilds from scratch, `diff -qr` against original to ensure reproducibility
5. Generates `SHA256SUMS.txt` for all release assets
6. Creates/updates GitHub Release with all assets

### Publish (`publish.yml`) -- Manual Dispatch Only

Two jobs with **environment-gated approvals**:

1. **submit-chrome** (environment: `chrome-web-store`)
  - Downloads `chrome.zip` from GitHub Release
  - Verifies SHA256 checksum
  - Submits via `pnpm wxt submit --chrome-zip`
2. **submit-firefox** (environment: `firefox-amo`)
  - Downloads `firefox.zip` + `firefox-sources.zip`
  - Verifies checksums
  - Validates Firefox publish gate
  - Submits via `pnpm wxt submit --firefox-zip --firefox-sources-zip --firefox-channel listed`
  - Supports `dry_run` mode

---

## Test Infrastructure

### Framework

**Vitest** with Chrome API mocks (`packages/shared/src/__test__/chrome-mock.ts`).

### Test Files (13 total)

**Background tests:**


| Test File               | Covers                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `background.test.ts`    | Service worker core: native message handling, popup communication, exit node restore, context menus, keepalive |
| `native-host.test.ts`   | Connection lifecycle, reconnection with exponential backoff, error handling                                    |
| `state-store.test.ts`   | State management: `update()`, `applyStatusUpdate()`, `subscribe()`, version incrementing                       |
| `badge-manager.test.ts` | Icon/badge updates for all state combinations                                                                  |
| `proxy-utils.test.ts`   | IP conversion, CIDR parsing, MagicDNS sanitization, subnet collection                                          |
| `timer-service.test.ts` | Timer abstraction contract                                                                                     |


**Proxy tests:**


| Test File                       | Covers                                                     |
| ------------------------------- | ---------------------------------------------------------- |
| `chrome-proxy-manager.test.ts`  | PAC script generation, proxy enable/disable, deduplication |
| `firefox-proxy-manager.test.ts` | Proxy listener, session storage persistence/restoration    |
| `firefox.test.ts`               | Firefox-specific keepalive via alarms                      |


**Popup tests:**


| Test File             | Covers                                              |
| --------------------- | --------------------------------------------------- |
| `popup.test.ts`       | View routing for all state combinations             |
| `peer-item.test.ts`   | Peer component rendering and actions                |
| `custom-urls.test.ts` | Custom URL storage                                  |
| `utils.test.ts`       | HTML escaping, clipboard, toast, platform detection |


### Running Tests

```bash
pnpm test              # Run all tests once
```

---

## Configuration Reference

### Extension IDs (`config/extension-ids.json`)

```json
{
  "chromeExtensionId": "bhfeceecialgilpedkoflminjgcjljll",
  "firefoxAddonId": "tailchrome@tesseras.org",
  "chromeNativeHostId": "com.tailscale.browserext.chrome",
  "firefoxNativeHostId": "com.tailscale.browserext.firefox"
}
```

### Manifest Permissions


| Permission                     | Purpose                                   |
| ------------------------------ | ----------------------------------------- |
| `proxy`                        | Configure browser proxy settings          |
| `storage`                      | Persist profileId, exit node, custom URLs |
| `nativeMessaging`              | Communicate with native host              |
| `contextMenus`                 | Right-click "Send page URL" menu          |
| `alarms`                       | Firefox-only: keepalive timer             |
| `<all_urls>` (host permission) | Proxy interception for all URLs           |


### Browser Storage Keys


| Key              | Storage                                  | Purpose                                         |
| ---------------- | ---------------------------------------- | ----------------------------------------------- |
| `profileId`      | `chrome.storage.local`                   | Browser profile UUID for tsnet isolation        |
| `lastExitNodeID` | `chrome.storage.local`                   | Persist exit node selection across reconnects   |
| `customUrls`     | `chrome.storage.local`                   | Per-device custom open targets                  |
| `proxyConfig`    | `browser.storage.session` (Firefox only) | Proxy state for surviving background suspension |


---

## Security Model

### Login URL Validation

Login URLs from the native host (`browseToURL`) are validated against an allowlist before opening:

- `https://login.tailscale.com`
- `https://controlplane.tailscale.com`

### Host Version Checking

The extension enforces major.minor version matching between the expected version (`EXPECTED_HOST_VERSION`) and the host's reported version. Patch version differences are tolerated. A mismatch shows the "needs-update" view.

### Proxy Scope

- Only browser traffic is proxied -- system networking is never modified
- The proxy binds to `127.0.0.1` only (not exposed to the network)
- When the extension is disabled or the service worker suspends, proxy settings are cleared to `DIRECT`

### Web Client CSRF

Requests to the Tailscale web client (`100.100.100.100`) include a `Sec-Tailscale: browser-ext` header for CSRF protection.

### Native Messaging

Native messaging is restricted to the declared extension IDs in the native host manifest. The Chrome manifest uses `allowed_origins`, Firefox uses `allowed_extensions`.

---

## Data Handling and Privacy

### Data Stored Locally


| Data                                      | Where                   | Purpose                                  |
| ----------------------------------------- | ----------------------- | ---------------------------------------- |
| `profileId`                               | Browser local storage   | Per-profile Tailscale node isolation     |
| `lastExitNodeID`                          | Browser local storage   | Exit node restoration                    |
| `customUrls`                              | Browser local storage   | Custom per-device URLs                   |
| `proxyConfig`                             | Firefox session storage | Proxy state restoration after suspension |
| `~/.config/tailscale-browser-ext/<UUID>/` | Filesystem              | tsnet state directory (keys, config)     |


### Data Transmitted

When enabled, Tailchrome transmits:

- Browsing activity and website content needed for proxy/exit-node traffic
- Authentication data for Tailscale login
- Device and network metadata for peer discovery
- User-initiated file contents for Taildrop transfers

Data is sent only to: the local native host, the user's Tailscale tailnet/control plane, and sites the user accesses through Tailchrome.

### Data NOT Collected

Tailchrome does not include analytics, crash telemetry, advertising identifiers, or marketing data.

Full policy: [docs/privacy-policy.md](privacy-policy.md)

---

## Store Listings

### Chrome Web Store

- **Category:** Productivity
- **Short description:** "Access your Tailscale tailnet directly from your browser. Per-profile VPN without touching system networking."
- **Extension ID:** `bhfeceecialgilpedkoflminjgcjljll`

### Firefox AMO

- **Categories:** Privacy & Security, Other
- **Addon ID:** `tailchrome@tesseras.org`
- **Minimum Firefox version:** 140.0
- **Source code disclosure:** `firefox-sources.zip` included with each release for AMO reviewer verification

Full listing text: [STORE_LISTING.md](STORE_LISTING.md)

---

## Contributing

1. Fork the repo and clone locally
2. Install dependencies: Go 1.25+, Node.js 22+, pnpm (via `corepack enable`)
3. `pnpm install --frozen-lockfile`
4. Build: `pnpm build:chrome`, `pnpm build:firefox`, `make host`
5. Load extension in browser for testing:
  - **Chrome:** `chrome://extensions` -> Developer Mode -> Load unpacked `packages/extension/.output/chrome-mv3/`
  - **Firefox:** `about:debugging#/runtime/this-firefox` -> Load temporary addon `packages/extension/.output/firefox-mv3/manifest.json`
6. Install native host by running the built binary directly

### Guidelines

- Open an issue first before submitting a PR
- Keep PRs focused -- one feature or fix per PR
- Write clear commit messages
- Test changes in both Chrome and Firefox
- Follow existing code patterns

Full guide: [CONTRIBUTING.md](CONTRIBUTING.md)

---

## Appendix: Go Dependencies

Key dependencies in `host/go.mod`:


| Dependency          | Version | Purpose                                                |
| ------------------- | ------- | ------------------------------------------------------ |
| `tailscale.com`     | v1.94.2 | tsnet, local client, IPN, socks5, proxymux, web client |
| `golang.org/x/term` | v0.38.0 | Terminal detection for auto-install                    |
| `golang.org/x/sys`  | v0.40.0 | System calls                                           |


