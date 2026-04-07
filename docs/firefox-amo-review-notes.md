# Firefox AMO Review Notes

## Package Under Review

- Add-on name: `Tailchrome`
- Firefox add-on ID: `tailchrome@tesseras.org`
- Target platform: desktop Firefox only
- Minimum Firefox version: `140.0`
- Companion native helper: downloaded separately from GitHub Releases

## What The Extension Does

Tailchrome connects a Firefox browser profile to the user's Tailscale tailnet without changing system-wide networking. The extension manages browser proxy behavior, exposes the popup UI, and talks to a local native helper via native messaging. The native helper runs the Tailscale node and local proxy for that browser profile.

## Permission Justification

### `proxy`

Required so the extension can route tailnet traffic, subnet traffic, and exit-node traffic through the local SOCKS5 proxy created by the helper.

### `<all_urls>`

Required because Firefox proxy resolution runs against requested URLs and Tailchrome must decide whether a request should go direct or through the local proxy for any destination. Tailchrome only proxies requests when they match tailnet IPs, MagicDNS names, advertised subnet CIDRs, or the user has explicitly enabled an exit node.

### `nativeMessaging`

Required to communicate with the local helper that runs the Tailscale node for the current browser profile. Without native messaging the extension cannot log in, discover peers, or proxy tailnet traffic.

### `storage`

Required to keep stable per-profile state and user preferences:

- `profileId`
- `lastExitNodeID`
- `customUrls`
- Firefox session-only `proxyConfig` restore state

### `contextMenus`

Required for the "Send page URL to Tailscale device" menu item.

### `alarms`

Firefox-only. Required to keep the background context alive long enough to maintain the native host connection and recover routing state after service-worker suspension.

## Data Transmission Disclosure

The Firefox manifest declares conservative required categories:

- `browsingActivity`
- `websiteContent`

Tailchrome does not include analytics or advertising trackers. These categories are declared because the extension proxies tailnet-bound browsing data through the local helper and onto the user's tailnet when the user has enabled the extension.

## Reviewer Test Notes

The extension requires the separate native helper to demonstrate full functionality. Reviewer steps:

1. Install the signed Firefox extension build.
2. Download the helper binary from the matching GitHub Release asset for the current OS.
3. Run the helper once to install the native messaging manifest.
4. Re-open the extension popup and sign in using the disposable reviewer account provided with the submission.

Provide the following reviewer-only materials at submission time:

- disposable Tailscale account credentials,
- the name of the dedicated reviewer tailnet,
- at least one reachable MagicDNS host,
- at least one reachable subnet route target,
- at least one available exit node,
- one Taildrop-capable peer for send-file verification.

## Source Rebuild

AMO reviewers can rebuild the submitted Firefox package from `firefox-sources.zip` using the steps in [`SOURCE_CODE_REVIEW.md`](../SOURCE_CODE_REVIEW.md).
