VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS = -ldflags "-X main.version=$(VERSION)"

.PHONY: all extension host clean dev

all: extension host

extension:
	cd extension && npm ci && npm run build

host:
	cd host && CGO_ENABLED=0 go build $(LDFLAGS) -o ../dist/tailscale-browser-ext .

host-all:
	cd host && GOOS=darwin  GOARCH=amd64 CGO_ENABLED=0 go build $(LDFLAGS) -o ../dist/tailscale-browser-ext-darwin-amd64 .
	cd host && GOOS=darwin  GOARCH=arm64 CGO_ENABLED=0 go build $(LDFLAGS) -o ../dist/tailscale-browser-ext-darwin-arm64 .
	cd host && GOOS=linux   GOARCH=amd64 CGO_ENABLED=0 go build $(LDFLAGS) -o ../dist/tailscale-browser-ext-linux-amd64 .
	cd host && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build $(LDFLAGS) -o ../dist/tailscale-browser-ext-windows-amd64.exe .

zip: extension
	mkdir -p dist
	cd extension/dist && zip -r ../../dist/tailchrome-$(VERSION).zip .

clean:
	rm -rf dist/ extension/dist/

dev:
	cd extension && npm run watch
