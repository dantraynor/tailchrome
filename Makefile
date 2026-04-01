VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS = -ldflags "-X main.version=$(VERSION)"

.PHONY: all extension extension-chrome extension-firefox host host-all clean dev zip zip-chrome zip-firefox

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

zip: zip-chrome zip-firefox

zip-chrome: extension-chrome
	pnpm zip:chrome

zip-firefox: extension-firefox
	pnpm zip:firefox

clean:
	pnpm clean

dev:
	pnpm --filter @tailchrome/extension dev
