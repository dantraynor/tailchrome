# Tailchrome Privacy Policy

Last updated: 2026-04-06

## Summary

Tailchrome does not include analytics, advertising trackers, or data brokers. The extension does transmit user data when it is necessary to connect Firefox to the user's Tailscale network through the local native helper.

## Data Stored In The Browser

Tailchrome stores the following data locally in browser storage:

- `profileId`: a generated identifier used to keep one Tailscale node per browser profile.
- `lastExitNodeID`: the most recently selected exit node so it can be restored after reconnect.
- `customUrls`: per-device custom open targets configured by the user.
- `proxyConfig` in Firefox session storage: the active proxy port, MagicDNS suffix, exit-node state, and subnet ranges needed to restore routing after the Firefox background context is suspended.

This data stays on the local device unless the user exports or syncs their browser profile separately.

## Data Transmitted By Tailchrome

When the extension is enabled, Tailchrome communicates with a local native helper over the browser's native messaging channel. That helper runs the Tailscale client logic for the current browser profile.

Depending on the features the user enables, Tailchrome may transmit:

- Browsing activity and website content needed to proxy tailnet-bound traffic, exit-node traffic, and Taildrop transfers.
- Authentication and session data needed to sign in to Tailscale.
- Device and network metadata required to discover peers, MagicDNS names, subnet routes, and exit nodes.
- User-initiated file contents when the user sends a file with Taildrop.

Tailchrome sends this data only to:

- the local native helper on the same machine,
- the user's Tailscale tailnet and Tailscale control plane, and
- the sites or services the user chooses to access through Tailchrome.

## Data Tailchrome Does Not Collect

Tailchrome does not send product analytics, crash telemetry, advertising identifiers, or marketing data to the developer.

## User Controls

Users can:

- disable Tailchrome from the extension popup,
- clear custom peer URLs from the popup,
- remove exit-node selection,
- log out of Tailscale, and
- uninstall the extension and native helper.

## Contact

For privacy or security questions, contact `admin@tesseras.org`.
