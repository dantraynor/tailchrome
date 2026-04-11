# Contributing to Tailchrome

Thanks for your interest in contributing! Please open an issue before submitting a PR so we can discuss the approach.

## Project Structure

```
packages/extension/   # WXT browser extension (Chrome + Firefox, Manifest V3)
packages/shared/      # Shared code — types, state management, popup UI
host/                 # Native messaging host (Go)
```

## Requirements

- Go 1.25+
- Node.js 22+
- pnpm
- Chrome or Firefox for manual testing

## Setup

1. `pnpm install --frozen-lockfile`
2. Build the extension and native host:
   ```
   pnpm build:chrome
   pnpm build:firefox
   make host
   ```
3. **Chrome:** `chrome://extensions` → Developer Mode → Load unpacked → `packages/extension/.output/chrome-mv3/`
4. **Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `packages/extension/.output/firefox-mv3/manifest.json`
5. Run the native host binary once to install it for both browsers

For live reloading during development, use `make dev` (WXT watch mode) and point Chrome at `packages/extension/.output/chrome-mv3-dev/`. Reload the extension after each rebuild.

## Build Commands

```
pnpm build:chrome        # Chrome extension
pnpm build:firefox       # Firefox extension
pnpm zip:chrome          # chrome.zip
pnpm zip:firefox         # firefox.zip + firefox-sources.zip
pnpm lint:firefox        # AMO-style validation
pnpm review:firefox      # Full Firefox validation pipeline
pnpm test                # All tests
pnpm typecheck           # TypeScript validation
make host                # Native host for current platform
make host-all            # All platform binaries
make dev                 # Chrome watch mode (WXT)
```

Extension builds go to `packages/extension/.output/`. Native host binaries go to `dist/`.

## Reporting Bugs

Include your browser, OS, extension version, and steps to reproduce.

## Release Pipeline

- PRs run extension typecheck/tests, Chrome build, the full Firefox review gate, and native host builds via GitHub Actions
- Tagged releases build all artifacts (extension zips, host binaries, macOS `.pkg` installer) and attach them to the GitHub Release
- Store publication uses GitHub Actions with manual environment approvals for Chrome Web Store and Firefox AMO submission
