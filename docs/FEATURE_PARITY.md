# Feature Parity: Tailchrome vs Native Tailscale Client

> Comparison of the Tailchrome browser extension against the native Tailscale desktop/mobile clients (macOS, Windows, Linux, iOS, Android).

Last updated: 2026-07-20

---

## Status Legend


| Symbol      | Meaning                               |
| ----------- | ------------------------------------- |
| **Yes**     | Fully supported in Tailchrome         |
| **Partial** | Supported with limitations            |
| **No**      | Not supported in Tailchrome           |
| **N/A**     | Not applicable to a browser extension |


---

## Connection & Identity


| Feature                       | Native Client | Tailchrome | Notes                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect / disconnect          | Yes           | Yes        | Toggle in popup header                                                                                                                                                                                                                                                     |
| Login to Tailscale            | Yes           | Yes        | Default-server login URLs use a strict Tailscale-origin allowlist. A configured custom coordination server may delegate to another HTTP(S) login origin; HTTPS custom servers still require HTTPS login URLs. When no URL is cached, the extension requests a fresh one. |
| Logout                        | Yes           | Yes        | Via popup                                                                                                                                                                                                                                                                  |
| Multiple profiles / accounts  | Yes           | Yes        | Create, switch, delete profiles                                                                                                                                                                                                                                            |
| Per-device identity           | Yes           | Yes        | Each browser profile gets its own isolated Tailscale node via `tsnet`                                                                                                                                                                                                      |
| Machine key re-authentication | Yes           | No         | Extension shows `NeedsMachineAuth` state but cannot trigger re-auth; user must use admin console                                                                                                                                                                           |
| Custom control server URL     | Yes           | Yes        | Advanced quick setting "Coordination server" accepts an `https://` URL (e.g. Headscale). Saving sends `ControlURL` through `set-prefs`, which triggers a logout + re-login against the new server. Leave blank to revert to Tailscale's default. Admin Console footer link is hidden while a custom server is configured.        |
| Auto-start on boot            | Yes           | N/A        | Extension activates when browser launches; native host is started on demand by the browser                                                                                                                                                                                 |
| Auto-connect on start         | Yes           | Yes        | Opt-in **Auto-connect on start** toggle in quick settings (off by default). When on, the extension sends `up` once per browser session if the first status after `init` reports `Stopped`/`NoState`; skipped for `NeedsLogin`/`NeedsMachineAuth`. A manual disconnect within the same session is respected even if the service worker restarts. The background registers `runtime.onStartup` so the browser wakes it at launch instead of waiting for the popup to open. Last exit node is restored separately when the node reaches `Running`. |


---

## Networking


| Feature                           | Native Client | Tailchrome | Notes                                                                                                                                                                                   |
| --------------------------------- | ------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access tailnet devices by IP      | Yes           | Yes        | Via SOCKS5/HTTP proxy on `127.0.0.1`                                                                                                                                                    |
| MagicDNS (access by hostname)     | Yes           | Yes        | `corpDNS` toggle in popup; PAC/listener routes `*.ts.net` suffix                                                                                                                        |
| Exit nodes (use)                  | Yes           | Yes        | Full exit node picker with search, country flags, online/offline status                                                                                                                 |
| Exit node suggestion              | Yes           | Yes        | The picker shows a client-side **Recommended** Mullvad row, preferring an online nearby location based on the browser time zone; it is never auto-applied. |
| Exit node: allow LAN access       | Yes           | Yes        | Toggle in exit node picker view                                                                                                                                                         |
| Exit node persistence             | Yes           | Yes        | Last-selected exit node saved to `chrome.storage.local` and restored after reconnect                                                                                                    |
| Split-tunneling (per-domain)      | No            | Yes        | Tailchrome-exclusive: under the Exit Node row, configure **Bypass** domains (skip the exit node) or **Only** domains (restrict the exit node to a listed set). Tailscale-internal traffic (MagicDNS, CGNAT, subnet routes) is never affected. |
| Subnet routing (use routes)       | Yes           | Yes        | Auto-detected from peer `subnets[]`; PAC/listener routes matching CIDRs                                                                                                                 |
| Subnet routing (advertise routes) | Yes           | Yes        | Advanced quick settings accept comma- or newline-separated CIDRs and apply `AdvertiseRoutes` through `set-prefs`. |
| Advertise as exit node            | Yes           | Yes        | Toggle in quick settings                                                                                                                                                                |
| Split DNS                         | Yes           | No         | Extension proxies based on destination IP/DNS suffix, but does not configure per-domain DNS resolvers                                                                                   |
| Custom DNS nameservers            | Yes           | No         | Not configurable from the extension                                                                                                                                                     |
| HTTPS proxy / CONNECT tunneling   | Yes           | Yes        | Native host handles `CONNECT` method with bidirectional hijack                                                                                                                          |
| IPv4 tailnet access               | Yes           | Yes        | Full support via CGNAT range `100.64.0.0/10`                                                                                                                                            |
| IPv6 tailnet access               | Yes           | Yes        | Chrome PAC and Firefox request routing recognize Tailscale's `fd7a:115c:a1e0::/48` range, including IPv6 literal URLs. |
| System-wide VPN                   | Yes           | N/A        | Tailchrome only routes browser traffic; system networking is never modified -- this is by design                                                                                        |
| WireGuard direct connections      | Yes           | Yes        | `tsnet` handles WireGuard under the hood                                                                                                                                                |
| DERP relay fallback               | Yes           | Yes        | `tsnet` handles DERP relay automatically                                                                                                                                                |


---

## Device Management


| Feature                          | Native Client | Tailchrome | Notes                                                                                                                    |
| -------------------------------- | ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| View peer list                   | Yes           | Yes        | Online/offline grouping, search, peer details                                                                            |
| Peer online/offline status       | Yes           | Yes        | Real-time via IPN bus watcher                                                                                            |
| Peer IP addresses                | Yes           | Yes        | Displayed and copyable (Copy IP button)                                                                                  |
| Peer DNS names                   | Yes           | Yes        | Displayed and copyable (Copy DNS button)                                                                                 |
| Peer OS information              | Yes           | Yes        | Shown in peer list with OS icons                                                                                         |
| Peer location (city/country)     | Yes           | Yes        | Shown for exit node peers with country flags                                                                             |
| Peer traffic stats (rx/tx bytes) | Yes           | Yes        | Receive/transmit totals appear in each peer's expanded details.                                                          |
| Peer last seen / last handshake  | Yes           | Yes        | Offline rows show last seen; expanded details show the last handshake.                                                   |
| Peer tags                        | Yes           | Yes        | Tags appear in expanded peer details and participate in search.                                                          |
| Peer user info                   | Yes           | Partial    | Owner login/display name appears in expanded details and search; profile pictures are not shown.                         |
| Open peer web interface          | Yes           | Yes        | "Open" button in peer item; also supports custom URLs per device                                                         |
| SSH to peer                      | Yes           | Partial    | Opens Tailscale web SSH client (`http://100.100.100.100/ssh/<hostname>`) in a new tab; not a native terminal SSH session |
| Custom peer URLs                 | No            | Yes        | Tailchrome-exclusive: configure per-device custom port/URL for quick access                                              |


---

## File Transfer (Taildrop)


| Feature                     | Native Client | Tailchrome | Notes                                                                                                                                  |
| --------------------------- | ------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Send files to peers         | Yes           | Yes        | Via peer item "Send File" button; base64-encoded, sent through `PushFile` API                                                          |
| Send files via context menu | No            | Yes        | Tailchrome-exclusive: right-click "Send page URL to Tailscale device" sends URL as text file                                           |
| Receive files from peers    | Yes           | No         | Extension cannot receive inbound file transfers; `tsnet` node could theoretically accept them but no handler is implemented            |
| File send progress          | Yes           | Yes        | Progress reported as percentage via toast notifications                                                                                |
| Drag-and-drop file send     | Yes           | No         | Files must be selected via file picker in the popup                                                                                    |
| Large file support          | Yes           | Partial    | Files are split into native-message-safe chunks and reassembled by the helper up to 50 MiB. The popup still reads and base64-encodes the full file in memory. |


---

## Security & Privacy


| Feature                     | Native Client | Tailchrome | Notes                                                                                                                   |
| --------------------------- | ------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| Shields Up (block inbound)  | Yes           | Yes        | Toggle in quick settings                                                                                                |
| Network lock (tailnet lock) | Yes           | No         | Not exposed in extension UI or native host protocol                                                                     |
| Key signing / rotation      | Yes           | No         | Not accessible from the extension                                                                                       |
| Key expiry visibility       | Yes           | Yes        | The connected status area shows the local node's key expiry; peer expiry is included in status data.                    |
| ACL management              | Yes           | No         | Managed via admin console (extension provides a link)                                                                   |
| MagicDNS HTTPS certificates | Yes           | No         | Not applicable -- browser handles TLS directly                                                                          |
| Tailscale SSH server (run)  | Yes           | No         | Host `PrefsView` includes `runSSH` but the extension UI does not expose a toggle for running an SSH server on this node |


---

## Tailscale Serve & Funnel


| Feature                                  | Native Client | Tailchrome | Notes                                           |
| ---------------------------------------- | ------------- | ---------- | ----------------------------------------------- |
| Serve (expose local services to tailnet) | Yes           | No         | Not implemented in the native host or extension |
| Funnel (expose services to internet)     | Yes           | No         | Not implemented in the native host or extension |


---

## Admin & Diagnostics


| Feature                                    | Native Client | Tailchrome | Notes                                                                                                        |
| ------------------------------------------ | ------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| Admin console access                       | Yes           | Yes        | "Admin" button opens `login.tailscale.com/admin` in new tab                                                  |
| Web client (manage node)                   | Yes           | Yes        | "Settings" button opens `http://100.100.100.100` (Tailscale web client served by native host)                |
| Health warnings                            | Yes           | Yes        | Collapsible banner in popup showing health warning messages from IPN bus                                     |
| Network diagnostics (`tailscale netcheck`) | Yes           | No         | Not exposed in extension                                                                                     |
| Ping peers (`tailscale ping`)              | Yes           | Yes        | Online peers expose a Ping action when the helper advertises support; results appear as a diagnostic toast. |
| Bug report generation                      | Yes           | No         | Not accessible from extension                                                                                |
| Debug logging                              | Yes           | Partial    | Native host logs to stderr (visible when launched from terminal); extension logs to browser devtools console |
| Version display                            | Yes           | Yes        | The connected footer shows the native helper version and incompatible versions open the update view.        |


---

## UI & Platform


| Feature                | Native Client | Tailchrome | Notes                                                                                                                                              |
| ---------------------- | ------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| System tray / menu bar | Yes           | N/A        | Extension uses browser toolbar icon with badge                                                                                                     |
| Desktop notifications  | Yes           | No         | Extension uses in-popup toast notifications only                                                                                                   |
| Dark mode              | Yes           | Yes        | Follows browser/system theme via CSS                                                                                                               |
| Keyboard navigation    | Yes           | Yes        | Arrow keys in peer list                                                                                                                            |
| Search                 | Yes           | Yes        | Peer search in popup                                                                                                                               |
| Auto-update            | Yes           | Partial    | Extension auto-updates via Chrome Web Store; native host updates use the platform helper installer when the extension shows "needs-update" |
| Cross-platform         | Yes           | Yes        | Extension: Chrome + Firefox. Host: macOS (amd64/arm64), Linux (amd64), Windows (amd64)                                                             |


---

## Summary

### What Tailchrome does well (at parity or better)

- **Core tailnet access** -- browsing devices by IP or MagicDNS name works seamlessly
- **Per-profile isolation** -- unique to Tailchrome; native client shares one identity per OS user
- **Exit nodes** -- full picker with suggestions, LAN access toggle, and persistence
- **Split-tunneling** -- Tailchrome-exclusive per-domain bypass/only rules layered on top of an exit node
- **Subnet routing** -- auto-detected and routed transparently
- **Profile management** -- create/switch/delete multiple Tailscale identities
- **Quick settings** -- Shields Up, advertise exit node, MagicDNS toggle all in the popup
- **Custom peer URLs** -- Tailchrome-exclusive feature for per-device quick access
- **Context menu file sharing** -- Tailchrome-exclusive right-click URL sharing
- **Zero system impact** -- only browser traffic is routed, never system networking

### What Tailchrome does NOT support


| Category          | Missing Features                                                                      |
| ----------------- | ------------------------------------------------------------------------------------- |
| **File transfer** | Receiving files (Taildrop inbound); sends are capped at 50 MiB and buffered in memory |
| **Networking**    | Split DNS, custom DNS nameservers                                                      |
| **Security**      | Network lock, key signing/rotation                                                    |
| **Services**      | Tailscale Serve, Tailscale Funnel, SSH server                                         |
| **Diagnostics**   | `netcheck` and user-facing bug-report generation                                      |
| **Admin**         | ACL management (link to admin console provided), machine re-auth                      |


### Architectural limitations

These gaps exist for fundamental reasons:

1. **No inbound connections to the browser** -- browsers cannot accept incoming TCP connections, so Taildrop receive, Serve, and Funnel are not possible without a separate receiver process.
2. **Native messaging payload limit** -- Chrome enforces a 1 MB message limit, so Taildrop sends are split into roughly 700 KB chunks and reassembled by the helper. The implementation caps assembled files at 50 MiB and still buffers the encoded file in extension/host memory.
3. **Browser sandbox** -- the extension cannot modify system DNS, routing tables, or network configuration. All networking goes through the SOCKS5/HTTP proxy, which means split DNS and custom nameserver configuration are not feasible from the browser alone.
4. **tsnet scope** -- the native host runs a `tsnet.Server`, which is a userspace Tailscale node. It does not have the full feature surface of `tailscaled` (the system daemon). Features like Serve, Funnel, and network lock require daemon-level integration that `tsnet` does not expose.
5. **UI surface area** -- the popup is constrained to a small window. Some features (SSH server toggle and advanced daemon diagnostics) remain omitted even when lower layers expose related data.
