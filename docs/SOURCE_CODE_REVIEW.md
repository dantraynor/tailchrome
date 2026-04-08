# Firefox Source Review

This repository ships the Firefox source ZIP from the workspace root so AMO reviewers can rebuild the extension exactly as released.

## Reviewer Bootstrap

1. Extract `firefox-sources.zip`.
2. Run `corepack enable`.
3. Run `pnpm install --frozen-lockfile`.
4. Run `pnpm --filter @tailchrome/extension zip:firefox`.

## Expected Output

The rebuilt Firefox artifacts are written to `packages/extension/.output/`:

- `firefox.zip`
- `firefox-sources.zip`
- `firefox-mv3/manifest.json`

## Scope

- The Firefox source ZIP includes only the files required to rebuild the browser extension from this workspace.
- The Go native host binaries are released separately and are not part of the AMO extension package or source ZIP.
- Reviewers do not need to build the Go native host to verify that the extension package matches the submitted Firefox artifacts.
