VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS = -ldflags "-X main.version=$(VERSION)"

.PHONY: all extension extension-chrome extension-firefox host host-all clean dev zip zip-chrome zip-firefox

all: extension host

extension: extension-chrome extension-firefox

extension-chrome:
	cd packages/chrome && pnpm install && pnpm run build

extension-firefox:
	cd packages/firefox && pnpm install && pnpm run build

host:
	cd host && CGO_ENABLED=0 go build $(LDFLAGS) -o ../dist/tailscale-browser-ext .

host-all:
	cd host && GOOS=darwin  GOARCH=amd64 CGO_ENABLED=0 go build $(LDFLAGS) -o ../dist/tailscale-browser-ext-darwin-amd64 .
	cd host && GOOS=darwin  GOARCH=arm64 CGO_ENABLED=0 go build $(LDFLAGS) -o ../dist/tailscale-browser-ext-darwin-arm64 .
	cd host && GOOS=linux   GOARCH=amd64 CGO_ENABLED=0 go build $(LDFLAGS) -o ../dist/tailscale-browser-ext-linux-amd64 .
	cd host && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build $(LDFLAGS) -o ../dist/tailscale-browser-ext-windows-amd64.exe .

zip: zip-chrome zip-firefox

zip-chrome: extension-chrome
	mkdir -p dist
	cd packages/chrome/dist && zip -r ../../../dist/tailchrome-chrome-$(VERSION).zip .

zip-firefox: extension-firefox
	mkdir -p dist
	cd packages/firefox/dist && zip -r ../../../dist/tailchrome-firefox-$(VERSION).zip .

clean:
	rm -rf dist/ packages/chrome/dist/ packages/firefox/dist/

dev:
	cd packages/chrome && pnpm run watch
