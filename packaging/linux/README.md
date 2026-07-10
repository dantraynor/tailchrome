# Linux Helper packages (.deb/.rpm)

`build-packages.sh` produces:

- `dist/tailchrome-helper-linux-amd64.deb`
- `dist/tailchrome-helper-linux-x86_64.rpm`

The packages install the helper binary at `/usr/lib/tailchrome/tailscale-browser-ext` and system-wide native messaging manifests for:

- Chrome: `/etc/opt/chrome/native-messaging-hosts/`
- Chromium: `/etc/chromium/native-messaging-hosts/`
- Edge: `/etc/opt/edge/native-messaging-hosts/`
- Firefox: `/usr/lib/mozilla/native-messaging-hosts/` (the .rpm additionally installs to `/usr/lib64/mozilla/native-messaging-hosts/`, where Fedora/RHEL Firefox builds look)

For additional Chromium-family browsers that do not support these system manifest locations, use the raw helper binary fallback from the release page. The raw binary runs `-install-now` for the current user and writes per-user manifests.

## Build

Install nFPM first:

```bash
go install github.com/goreleaser/nfpm/v2/cmd/nfpm@latest
```

Then build from the repository root:

```bash
make host-all
./packaging/linux/build-packages.sh
```
