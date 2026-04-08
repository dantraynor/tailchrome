# Firefox AMO Launch Checklist

## Listing Basics

- Add-on name: `Tailchrome`
- Category: `Privacy & Security`
- Distribution: `Listed`
- Platform scope: desktop Firefox only
- Minimum Firefox version: `140.0`
- Add-on ID: `tailchrome@tesseras.org`

## Store URLs

- Homepage URL: `https://tesseras.org/tailchrome/`
- Support URL: `https://github.com/dantraynor/tailchrome/issues`
- Privacy policy URL: `https://github.com/dantraynor/tailchrome/blob/main/docs/privacy-policy.md`
- Source repository: `https://github.com/dantraynor/tailchrome`
- Release downloads: `https://github.com/dantraynor/tailchrome/releases/latest`

## AMO Listing Copy

### Summary

Access your Tailscale network directly from Firefox without changing system-wide networking.

### Description

Tailchrome runs a full Tailscale node per browser profile and routes tailnet traffic through a local helper, so Firefox can reach MagicDNS names, subnet routes, exit nodes, and Taildrop targets without requiring a system VPN.

Features:

- per-profile Tailscale identity
- MagicDNS and tailnet IP access
- subnet routing
- exit nodes
- Taildrop
- multiple profiles

Tailchrome requires a separate native helper downloaded from GitHub Releases. The helper installs the Firefox native messaging manifest and runs the local Tailscale proxy used by the extension.

### Privacy Disclosure Notes

- Required categories: `browsingActivity`, `websiteContent`
- No analytics or advertising trackers
- Data is transmitted only as needed to log in to Tailscale, proxy traffic onto the user's tailnet, and complete user-initiated actions such as Taildrop

## Media Assets

Upload these existing store assets:

- `store-assets/screenshot-1-hero.png`
- `store-assets/screenshot-2-popup.png`
- `store-assets/screenshot-3-features.png`
- `store-assets/screenshot-4-exit-nodes.png`
- `store-assets/screenshot-5-actions.png`
- `store-assets/promo-small.png`
- `store-assets/promo-marquee.png`

## Submission Payload

Upload from the matching GitHub Release:

- `firefox.zip`
- `firefox-sources.zip`
- reviewer notes from `docs/firefox-amo-review-notes.md`

## Helper Install Explanation

Use this wording in reviewer notes and any store responses:

Tailchrome's Firefox add-on package does not contain native binaries. The separate helper is downloaded from GitHub Releases, installed locally by the user, and registered through Firefox native messaging so the extension can run a Tailscale node for the current browser profile.

## Reviewer Account Checklist

Provide these with the first listed submission:

- disposable Tailscale login credentials
- reviewer tailnet name
- one reachable MagicDNS host
- one subnet-routed target
- one available exit node
- one Taildrop-capable recipient
- helper install instructions for macOS, Windows, and Linux

## Post-Approval Follow-Ups

After the AMO listing is approved:

1. Record the live AMO URL and listing slug in release docs.
2. Set `FIREFOX_EXTENSION_ID` in the `firefox-amo` GitHub environment to the live listing identifier.
3. Verify `FIREFOX_JWT_ISSUER` and `FIREFOX_JWT_SECRET` are present in the same environment.
4. Run the `publish.yml` workflow once with `targets=firefox` and `dry_run=true`.
5. Replace the temporary GitHub Releases install text in the README and website with the AMO listing URL.
