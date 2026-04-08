# Feature Parity: Tailchrome vs Native Tailscale Client

> Comparison of the Tailchrome browser extension against the native Tailscale desktop/mobile clients (macOS, Windows, Linux, iOS, Android).

Last updated: 2026-04-06

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
| Login to Tailscale            | Yes           | Yes        | Opens login URL in new tab (validated against `login.tailscale.com` and `controlplane.tailscale.com`)                                                                                                                                                                      |
| Logout                        | Yes           | Yes        | Via popup                                                                                                                                                                                                                                                                  |
| Multiple profiles / accounts  | Yes           | Yes        | Create, switch, delete profiles                                                                                                                                                                                                                                            |
| Per-device identity           | Yes           | Yes        | Each browser profile gets its own isolated Tailscale node via `tsnet`                                                                                                                                                                                                      |
| Machine key re-authentication | Yes           | No         | Extension shows `NeedsMachineAuth` state but cannot trigger re-auth; user must use admin console                                                                                                                                                                           |
| Custom control server URL     | Yes           | No         | Host `PrefsView` includes `controlURL` but the extension UI does not expose it; hardcoded to default Tailscale control plane                                                                                                                                               |
| Auto-start on boot            | Yes           | N/A        | Extension activates when browser launches; native host is started on demand by the browser                                                                                                                                                                                 |
| Auto-connect on start         | Yes           | No         | After `init`, the extension requests `get-status` and `list-profiles` but does not send `up`; the node resumes whatever state it was last in. The user must toggle manually if the node was previously stopped. Last exit node is restored if the node is already running. |


---

## Networking


| Feature                           | Native Client | Tailchrome | Notes                                                                                                                                                                                   |
| --------------------------------- | ------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access tailnet devices by IP      | Yes           | Yes        | Via SOCKS5/HTTP proxy on `127.0.0.1`                                                                                                                                                    |
| MagicDNS (access by hostname)     | Yes           | Yes        | `corpDNS` toggle in popup; PAC/listener routes `*.ts.net` suffix                                                                                                                        |
| Exit nodes (use)                  | Yes           | Yes        | Full exit node picker with search, country flags, online/offline status                                                                                                                 |
| Exit node suggestion              | Yes           | Yes        | "Suggest" button calls `SuggestExitNode` API; shown as toast (not auto-applied)                                                                                                         |
| Exit node: allow LAN access       | Yes           | Yes        | Toggle in exit node picker view                                                                                                                                                         |
| Exit node persistence             | Yes           | Yes        | Last-selected exit node saved to `chrome.storage.local` and restored after reconnect                                                                                                    |
| Subnet routing (use routes)       | Yes           | Yes        | Auto-detected from peer `subnets[]`; PAC/listener routes matching CIDRs                                                                                                                 |
| Subnet routing (advertise routes) | Yes           | No         | Host supports `AdvertiseRoutes` in `set-prefs`, but the UI does not expose route advertisement configuration                                                                            |
| Advertise as exit node            | Yes           | Yes        | Toggle in quick settings                                                                                                                                                                |
| Split DNS                         | Yes           | No         | Extension proxies based on destination IP/DNS suffix, but does not configure per-domain DNS resolvers                                                                                   |
| Custom DNS nameservers            | Yes           | No         | Not configurable from the extension                                                                                                                                                     |
| HTTPS proxy / CONNECT tunneling   | Yes           | Yes        | Native host handles `CONNECT` method with bidirectional hijack                                                                                                                          |
| IPv4 tailnet access               | Yes           | Yes        | Full support via CGNAT range `100.64.0.0/10`                                                                                                                                            |
| IPv6 tailnet access               | Yes           | Partial    | Host reports IPv6 addresses in `tailscaleIPs[]`; proxy routing depends on browser PAC/listener URL matching, which works for direct IP access but IPv6 literal URLs may have edge cases |
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
| Peer traffic stats (rx/tx bytes) | Yes           | Partial    | Data available in `PeerInfo` but not currently displayed in the popup UI                                                 |
| Peer last seen / last handshake  | Yes           | Partial    | Data available in `PeerInfo` but not currently displayed in the popup UI                                                 |
| Peer tags                        | Yes           | Partial    | Data available in `PeerInfo` but not currently displayed in the popup UI                                                 |
| Peer user info                   | Yes           | Partial    | `userName`, `userLoginName`, `userProfilePicURL` available in `PeerInfo` but not displayed                               |
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
| Large file support          | Yes           | Partial    | Limited by Chrome's 1 MB native messaging payload size; files are base64-encoded in memory, so practical limit is ~750 KB per transfer |


---

## Security & Privacy


| Feature                     | Native Client | Tailchrome | Notes                                                                                                                   |
| --------------------------- | ------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| Shields Up (block inbound)  | Yes           | Yes        | Toggle in quick settings                                                                                                |
| Network lock (tailnet lock) | Yes           | No         | Not exposed in extension UI or native host protocol                                                                     |
| Key signing / rotation      | Yes           | No         | Not accessible from the extension                                                                                       |
| Key expiry visibility       | Yes           | Partial    | `selfNode.keyExpiry` is available in the type definition but not displayed in the UI                                    |
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
| Ping peers (`tailscale ping`)              | Yes           | No         | Extension sends keepalive pings to native host but cannot ping tailnet peers                                 |
| Bug report generation                      | Yes           | No         | Not accessible from extension                                                                                |
| Debug logging                              | Yes           | Partial    | Native host logs to stderr (visible when launched from terminal); extension logs to browser devtools console |
| Version display                            | Yes           | Partial    | Host version shown internally for mismatch detection, but not displayed to user in the popup                 |


---

## UI & Platform


| Feature                | Native Client | Tailchrome | Notes                                                                                                                                              |
| ---------------------- | ------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| System tray / menu bar | Yes           | N/A        | Extension uses browser toolbar icon with badge                                                                                                     |
| Desktop notifications  | Yes           | No         | Extension uses in-popup toast notifications only                                                                                                   |
| Dark mode              | Yes           | Yes        | Follows browser/system theme via CSS                                                                                                               |
| Keyboard navigation    | Yes           | Yes        | Arrow keys in peer list                                                                                                                            |
| Search                 | Yes           | Yes        | Peer search in popup                                                                                                                               |
| Auto-update            | Yes           | Partial    | Extension auto-updates via Chrome Web Store; native host requires manual update (extension detects version mismatch and shows "needs-update" view) |
| Cross-platform         | Yes           | Yes        | Extension: Chrome + Firefox. Host: macOS (amd64/arm64), Linux (amd64), Windows (amd64)                                                             |


---

## Summary

### What Tailchrome does well (at parity or better)

- **Core tailnet access** -- browsing devices by IP or MagicDNS name works seamlessly
- **Per-profile isolation** -- unique to Tailchrome; native client shares one identity per OS user
- **Exit nodes** -- full picker with suggestions, LAN access toggle, and persistence
- **Subnet routing** -- auto-detected and routed transparently
- **Profile management** -- create/switch/delete multiple Tailscale identities
- **Quick settings** -- Shields Up, advertise exit node, MagicDNS toggle all in the popup
- **Custom peer URLs** -- Tailchrome-exclusive feature for per-device quick access
- **Context menu file sharing** -- Tailchrome-exclusive right-click URL sharing
- **Zero system impact** -- only browser traffic is routed, never system networking

### What Tailchrome does NOT support


| Category          | Missing Features                                                                      |
| ----------------- | ------------------------------------------------------------------------------------- |
| **File transfer** | Receiving files (Taildrop inbound), large files (>~750 KB)                            |
| **Networking**    | Advertise subnet routes, split DNS, custom DNS nameservers, custom control server URL |
| **Security**      | Network lock, key signing/rotation, key expiry display                                |
| **Services**      | Tailscale Serve, Tailscale Funnel, SSH server                                         |
| **Diagnostics**   | `netcheck`, `ping` peers, bug reports                                                 |
| **Admin**         | ACL management (link to admin console provided), machine re-auth                      |


### Architectural limitations

These gaps exist for fundamental reasons:

1. **No inbound connections to the browser** -- browsers cannot accept incoming TCP connections, so Taildrop receive, Serve, and Funnel are not possible without a separate receiver process.
2. **Native messaging payload limit** -- Chrome enforces a 1 MB message size limit. Since files are base64-encoded (33% overhead), the practical file send limit is approximately 750 KB. Larger files would require chunking, which is not currently implemented.
3. **Browser sandbox** -- the extension cannot modify system DNS, routing tables, or network configuration. All networking goes through the SOCKS5/HTTP proxy, which means split DNS and custom nameserver configuration are not feasible from the browser alone.
4. **tsnet scope** -- the native host runs a `tsnet.Server`, which is a userspace Tailscale node. It does not have the full feature surface of `tailscaled` (the system daemon). Features like Serve, Funnel, and network lock require daemon-level integration that `tsnet` does not expose.
5. **UI surface area** -- the popup is constrained to a small window. Some features (subnet route advertisement, SSH server toggle, detailed peer stats) are omitted from the UI to keep it focused, even though the underlying protocol and host may support them.

