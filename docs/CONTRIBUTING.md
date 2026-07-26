# Contributing to Tailchrome

Thanks for your interest in contributing. Please open an issue before submitting a PR so we can discuss the approach.

## Project Structure

```
packages/extension/   # WXT browser extension (Chrome + Firefox, Manifest V3)
packages/shared/      # Shared code — types, state management, popup UI
host/                 # Native messaging host (Go)
```

## Requirements

- Go 1.26.5+
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
pnpm test:installer      # Hermetic macOS/Linux fallback-installer tests
pnpm typecheck           # TypeScript validation
pnpm e2e:chrome          # Puppeteer smoke suite (Chrome)
pnpm e2e:firefox         # Puppeteer smoke suite (Firefox)
pnpm e2e:full            # Full Puppeteer suite, both browsers
make host                # Native host for current platform
make host-all            # All platform binaries
make dev                 # Chrome watch mode (WXT)
```

Extension builds go to `packages/extension/.output/`. Native host binaries and helper installers go to `dist/`.

See [puppeteer-testing-suite.md](puppeteer-testing-suite.md) for the end-to-end harness layout.

Before changing helper activation or packaging, run the focused tests for the
seam you touched, then finish with:

```bash
pnpm typecheck
pnpm test
pnpm test:installer
(cd host && go test -race ./... && go vet ./...)
git diff --check
```

Pull-request CI runs ShellCheck 0.11.0 over the fallback installer and Linux
packaging scripts and actionlint 1.7.12 over the workflow files. Contributors
do not need to install either tool globally; the pinned CI checks are
authoritative.

## Reporting Bugs

Include your browser, OS, extension version, and steps to reproduce.

## Release Pipeline

- PRs run extension tests, Chrome checks, the full Firefox review gate, Go
  tests on Linux and Windows, fallback-installer tests, a macOS package smoke
  build, Windows signature-verifier fixtures, and Linux package metadata
  checks.
- A helper release first produces one immutable candidate artifact containing
  the extension archives, signed macOS/Windows helpers and installers, existing
  verified amd64/x86_64 Linux packages, Linux amd64/arm64 raw helpers, the fallback
  installer, final checksums, and signature summaries.
- Publication is a separate protected workflow. It accepts the original
  candidate run ID, release tag, and checksum-manifest digest; downloads those
  exact bytes; repeats structural and signature checks; and waits for
  exact-hash Defender/Malwarebytes clearance before publishing one coordinated
  release.
- The production Windows signing job is unavailable until
  [WINDOWS_CODE_SIGNING_POLICY.md](WINDOWS_CODE_SIGNING_POLICY.md) records one
  accepted provider and exact signer subject. Signing cannot silently skip or
  switch publisher identities.
- Store publication uses GitHub Actions with manual environment approvals for Chrome Web Store and Firefox AMO submission
