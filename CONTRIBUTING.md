# Contributing to Tailchrome

Thanks for your interest in contributing!

## Getting Started

1. Fork the repo and clone it locally
2. Install dependencies: Go 1.21+, Node.js 18+, pnpm
3. Run `make all` to build everything

## How to Contribute

- **Open an issue first** before submitting a PR so we can discuss the approach
- Keep PRs focused — one feature or fix per PR
- Write clear commit messages describing what changed and why
- Follow existing code patterns and conventions

## Development

- Chrome extension: `cd extension && pnpm install && pnpm dev`
- Native host: `cd host && go build ./...`
- Test your changes in both Chrome and Firefox before submitting

## Reporting Bugs

Include your browser, OS, extension version, and steps to reproduce.
