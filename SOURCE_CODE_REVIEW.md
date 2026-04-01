# Firefox Source Review

This repository ships the Firefox source ZIP from the workspace root so AMO reviewers can rebuild the extension exactly as released.

## Rebuild Steps

1. Extract `firefox-sources.zip`.
2. Run `pnpm install --frozen-lockfile`.
3. Run `pnpm --filter @tailchrome/extension zip:firefox`.

The rebuilt Firefox artifacts are written to `packages/extension/.output/`:

- `firefox.zip`
- `firefox-sources.zip`

## Scope

- The Firefox source ZIP includes only the files required to rebuild the browser extension from this workspace.
- The Go native host binaries are released separately and are not part of the AMO extension package or source ZIP.
