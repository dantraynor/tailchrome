# Homebrew installation

This repository is also a Homebrew tap. The macOS cask uses the signed,
notarized universal `.pkg`. The formula builds the helper from a checksummed
release source archive on macOS and Linux, with Go as a build dependency.
Both pin a release version and SHA-256 checksum.

Install [Homebrew](https://brew.sh/) and add the tap:

```bash
brew tap dantraynor/tailchrome https://github.com/dantraynor/tailchrome
```

The explicit URL is required because this repository is named `tailchrome`,
rather than `homebrew-tailchrome`. This is a project tap, not an entry in
Homebrew's core or cask repositories. Install the browser extension separately
from the [Chrome Web Store](https://chromewebstore.google.com/detail/tailchrome/bhfeceecialgilpedkoflminjgcjljll)
or [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tailchrome/).

## macOS

```bash
brew install --cask dantraynor/tailchrome/tailchrome
```

The package requires an administrator password and supports both Apple Silicon
and Intel Macs. It installs `/Applications/Tailchrome Helper.app` and the helper
at `/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext`.
The package registers a per-user runtime copy for the logged-in console user.
Restart your browser after installation.

To repair discovery or register another macOS user, open **Tailchrome Helper**
in that account, or run:

```bash
"/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext" -install-now
```

Before upgrading, disconnect Tailchrome and close your browsers:

```bash
brew update
brew upgrade --cask dantraynor/tailchrome/tailchrome
```

Reopen your browsers when the upgrade finishes. Other macOS accounts that use
Tailchrome should run the repair command above to refresh their runtime copy.

To uninstall, disconnect Tailchrome and close your browsers, then run:

```bash
brew uninstall --cask dantraynor/tailchrome/tailchrome
```

The cask invokes the helper's `-uninstall` command as the current user before
removing the package payload and receipt (`org.tesseras.tailchrome.helper`).
If other accounts used Tailchrome, run the following once in each account
**before** uninstalling the cask:

```bash
"/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext" -uninstall
```

## Source formula (macOS and Linux)

The formula builds the native helper locally for your architecture. It does
not install the macOS package or **Tailchrome Helper.app**; register the helper
with the command below. Go is needed only to build the helper.

```bash
brew install --formula dantraynor/tailchrome/tailchrome
tailscale-browser-ext -install-now
```

Run registration without `sudo`. The helper registers Chrome, Firefox, and
the other supported Chromium-family browsers for your current user. Homebrew
owns the built helper in its prefix; the registration command owns a separate
runtime copy and your native-messaging manifests. The runtime copy lives at:

- macOS: `~/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext`
- Linux: `~/.local/share/tailscale/browser-ext/tailscale-browser-ext`

After **every** upgrade, disconnect Tailchrome and close your browsers before
refreshing that runtime copy:

```bash
brew update
brew upgrade --formula dantraynor/tailchrome/tailchrome
tailscale-browser-ext -install-now
```

Reopen your browser after registration finishes. The same registration command
repairs discovery. Run it in each account that uses Tailchrome. If the executable
is not on `PATH`, use `"$(brew --prefix tailchrome)/bin/tailscale-browser-ext"`.

Before removing the formula, disconnect Tailchrome and close your browsers,
then run:

```bash
tailscale-browser-ext -uninstall
brew uninstall --formula dantraynor/tailchrome/tailchrome
```

Run `-uninstall` in each registered user account before removing the formula.
If you already removed it, run the runtime copy's `-uninstall` command using
the path for your platform:

```bash
# macOS
"$HOME/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext" -uninstall
# Linux
"$HOME/.local/share/tailscale/browser-ext/tailscale-browser-ext" -uninstall
```

Neither platform's uninstall deletes Tailscale identities or profile data.
Use one helper installation method at a time; per-user registrations can take
precedence over package registrations. When switching from another installer,
disconnect Tailchrome, close browsers, follow that installer's uninstall steps,
then install and register with Homebrew.

Homebrew does not install a native Windows helper. Use the
[Windows MSI](../windows/README.md) for browsers running on Windows, including
when Homebrew is available inside WSL.

## Maintaining the tap

`Casks/tailchrome.rb` and `Formula/tailchrome.rb` track the latest **published**
stable helper release. Do not bump them with `scripts/bump-version.sh`: the
cask's final checksum is available only after signing, notarization, and packaging.

After protected helper publication succeeds, `Publish Helper Release` calls
`Update Homebrew`. That workflow verifies the public release and the approved
`SHA256SUMS.txt` digest for the cask. It also downloads the release tag's source
archive, checks its declared version, and computes the formula's SHA-256.
GitHub's source archive is separate from the signed package manifest; review
its tag and checksum independently. The workflow updates both definitions,
tests the updater, and opens a pull request against `main`. It uses this
repository's `GITHUB_TOKEN`; no separate tap repository or PAT is needed.
Merge the update PR to make the new version
available through `brew update`.

For automatic PR creation, enable **Settings → Actions → General → Workflow
permissions → Allow GitHub Actions to create and approve pull requests**. This
workflow only creates PRs; it does not approve or merge them. Approve any pending
CI workflow runs on the automated PR before merging; see GitHub's
[GITHUB_TOKEN workflow rules](https://docs.github.com/en/actions/concepts/security/github_token).
If your GitHub deployment does not create runs for these PRs, close and reopen
the PR as a maintainer to trigger CI. The workflow also saves a
`homebrew-update-vX.Y.Z` patch artifact so updates remain available when PR
creation is disabled or branch protection prevents the push. A PR creation
failure produces a warning with this fallback and does not fail the helper
publication job.

If an update fails, the helper release stays published. Re-run `Update Homebrew`
from `main` with the same `release_tag` and `sha256sums_digest`. The workflow
rejects drafts and prereleases; the updater rejects malformed/missing/duplicate
checksums and version downgrades. Existing update PRs are left for review.

For a manual update, replace `vX.Y.Z` with the published release tag:

```bash
mkdir -p .context/homebrew-update
gh release download vX.Y.Z --repo dantraynor/tailchrome \
  --pattern SHA256SUMS.txt --dir .context/homebrew-update
# Compare this digest with the approved publication summary before continuing.
shasum -a 256 .context/homebrew-update/SHA256SUMS.txt
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/dantraynor/tailchrome/archive/refs/tags/vX.Y.Z.tar.gz \
  --output .context/homebrew-update/vX.Y.Z.tar.gz
shasum -a 256 .context/homebrew-update/vX.Y.Z.tar.gz
node scripts/update-homebrew.mjs vX.Y.Z .context/homebrew-update/SHA256SUMS.txt \
  .context/homebrew-update/vX.Y.Z.tar.gz
pnpm test:homebrew
git diff --check
git diff -- Casks/tailchrome.rb Formula/tailchrome.rb
```

Commit the reviewed definition updates through a pull request. CI builds the
formula from source on macOS and Linux and tests registration and removal in
Homebrew's temporary test home. It also checks cask syntax/style on macOS and
fetches the package to verify its checksum, signature, and stapled notarization
ticket. Full macOS cask install/upgrade/uninstall still needs a Mac with a
logged-in user; follow the commands above and check browser discovery after
each step.

## Preparing a Homebrew core submission

`Formula/tailchrome.rb` builds from source on both supported platforms and can
be proposed to [Homebrew/homebrew-core](https://github.com/Homebrew/homebrew-core)
as `Formula/t/tailchrome.rb`. Follow Homebrew's
[new formula checklist](https://docs.brew.sh/Adding-Software-to-Homebrew) and
[acceptance requirements](https://docs.brew.sh/Acceptable-Formulae). In a local
checkout of that tap, validate the formula before opening the upstream PR:

```bash
brew style --formula homebrew/core/tailchrome
brew audit --new --strict --online --formula homebrew/core/tailchrome
HOMEBREW_NO_INSTALL_FROM_API=1 brew install --build-from-source --formula homebrew/core/tailchrome
brew test homebrew/core/tailchrome
```

Homebrew reviews eligibility and generates bottles through its own CI. Core
acceptance is separate from this project's tap; the release workflow above
updates only this repository. Once accepted, submit later core updates through
Homebrew's contribution process as well.
