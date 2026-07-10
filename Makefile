VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
# Tailscale library version, read from go.mod and stamped into the binary so the
# embedded tsnet node reports a clean version (e.g. "1.94.2") instead of the
# "-ERR-BuildInfo"/"-dev" fallback that a plain `go build` produces. Derived (not
# hardcoded) so it tracks the pinned dependency automatically when it is bumped.
TS_VERSION = $(shell cd host && go list -m -f '{{.Version}}' tailscale.com 2>/dev/null | sed 's/^v//')
LDFLAGS = -ldflags "-X main.version=$(VERSION) -X tailscale.com/version.shortStamp=$(TS_VERSION) -X tailscale.com/version.longStamp=$(TS_VERSION)"

.PHONY: all extension extension-chrome extension-firefox host host-all macos-pkg windows-msi linux-packages clean dev zip zip-chrome zip-firefox

all: extension host

extension: extension-chrome extension-firefox

extension-chrome:
	pnpm build:chrome

extension-firefox:
	pnpm build:firefox

host:
	cd host && CGO_ENABLED=0 go build $(LDFLAGS) -o ../dist/tailscale-browser-ext .

host-all:
	cd host && GOOS=darwin  GOARCH=amd64 CGO_ENABLED=0 go build $(LDFLAGS) -o ../dist/tailscale-browser-ext-darwin-amd64 .
	cd host && GOOS=darwin  GOARCH=arm64 CGO_ENABLED=0 go build $(LDFLAGS) -o ../dist/tailscale-browser-ext-darwin-arm64 .
	cd host && GOOS=linux   GOARCH=amd64 CGO_ENABLED=0 go build $(LDFLAGS) -o ../dist/tailscale-browser-ext-linux-amd64 .
	cd host && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build $(LDFLAGS) -o ../dist/tailscale-browser-ext-windows-amd64.exe .

# macOS only: universal .pkg installer (requires lipo, pkgbuild)
macos-pkg:
	./packaging/macos/build-pkg.sh

# Windows only: per-user .msi installer (requires WiX)
windows-msi:
	pwsh ./packaging/windows/build-msi.ps1

# Linux only: .deb and .rpm installers (requires nFPM)
linux-packages:
	./packaging/linux/build-packages.sh

zip: zip-chrome zip-firefox

zip-chrome: extension-chrome
	pnpm zip:chrome

zip-firefox: extension-firefox
	pnpm zip:firefox

clean:
	pnpm clean

dev:
	pnpm --filter @tailchrome/extension dev
