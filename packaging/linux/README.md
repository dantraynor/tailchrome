# Linux helper installation

`build-packages.sh` produces:

- `dist/tailchrome-helper-linux-amd64.deb`
- `dist/tailchrome-helper-linux-x86_64.rpm`

These amd64 packages are the primary installation method on compatible Linux
systems. They install the helper binary at
`/usr/lib/tailchrome/tailscale-browser-ext` and system-wide native-messaging
manifests for:

- Chrome: `/etc/opt/chrome/native-messaging-hosts/`
- Chromium: `/etc/chromium/native-messaging-hosts/`
- Edge: `/etc/opt/edge/native-messaging-hosts/`
- Firefox: `/usr/lib/mozilla/native-messaging-hosts/` (the .rpm additionally installs to `/usr/lib64/mozilla/native-messaging-hosts/`, where Fedora/RHEL Firefox builds look)

Package ownership stops at those system files. The packages have no
post-install registration script and write nothing below a user's home
directory, so removing the package removes everything it owns.

ARM64 `.deb` and `.rpm` packages are not published. Linux ARM64 users use the
verified `tailscale-browser-ext-linux-arm64` raw helper through the repair
script described below.

## Per-user registration repair

Use the release's `tailchrome-install.sh` only when a compatible system package
is unavailable or the browser still cannot discover the package-installed
helper. The script selects `linux-amd64` or `linux-arm64` from the runtime
architecture, verifies the raw helper, runs it with `-install-now`, and writes
registration only for the current user.

Pin the extension release version, download the installer and checksum file,
verify them, inspect the script, and then execute it:

```bash
VERSION=vX.Y.Z
RELEASE_URL="https://github.com/dantraynor/tailchrome/releases/download/$VERSION"

curl --fail --location --proto '=https' --tlsv1.2 \
  --output tailchrome-install.sh \
  "$RELEASE_URL/tailchrome-install.sh"
curl --fail --location --proto '=https' --tlsv1.2 \
  --output SHA256SUMS.txt \
  "$RELEASE_URL/SHA256SUMS.txt"

grep -E '^[0-9a-f]{64}  tailchrome-install\.sh$' SHA256SUMS.txt \
  >tailchrome-install.sh.sha256
test "$(wc -l <tailchrome-install.sh.sha256)" -eq 1
sha256sum --check tailchrome-install.sh.sha256
gh attestation verify tailchrome-install.sh --repo dantraynor/tailchrome

less tailchrome-install.sh
chmod 755 tailchrome-install.sh
./tailchrome-install.sh --version "$VERSION"
```

The `gh` attestation check is optional when GitHub CLI is unavailable or not
authenticated (`gh auth login`). In that case the installer prints a warning
that its checksum and artifact share the same GitHub Release trust boundary. Do not pipe a remote script directly to a
shell.

The installed Linux helper path is:

```text
$HOME/.local/share/tailscale/browser-ext/tailscale-browser-ext
```

To remove the current-user helper and its manifests, use the same inspected
script with the pinned version:

```bash
./tailchrome-install.sh --version "$VERSION" --uninstall
```

This invokes the installed helper directly with `-uninstall`; it does not
assume that `tailscale-browser-ext` is on `PATH`.

## Build

Install nFPM first:

```bash
go install github.com/goreleaser/nfpm/v2/cmd/nfpm@v2.47.0
```

Then build from the repository root:

```bash
make host-linux-amd64 host-linux-arm64
file dist/tailscale-browser-ext-linux-amd64
file dist/tailscale-browser-ext-linux-arm64
go version -m dist/tailscale-browser-ext-linux-amd64
go version -m dist/tailscale-browser-ext-linux-arm64
./packaging/linux/build-packages.sh
```

`build-packages.sh` consumes only the amd64 raw helper. Adding the ARM64 raw
build does not change either package architecture or package contents.
