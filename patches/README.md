# Dependency patches

`addons-linter@10.10.0.patch` uses `probe-image-size` for image metadata instead
of the vulnerable `image-size` dependency. Its dependency replacement is declared
in the root pnpm configuration.

`@devicefarmer__adbkit@3.3.9.patch` replaces adbkit's uses of `node-forge` with
Node.js crypto to address [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
Both Firefox tooling dependency paths use this patched version;
the pnpm override removes the unused `node-forge` dependency entirely. This fixes
the dependency exposure without suppressing audit findings. Remove this patch
when upstream releases an equivalent fix.

The patch retains Android key parsing, fingerprints, ADB challenge verification,
and the CLI's PEM/OpenSSH conversions. ADB passes a prehashed SHA-1 challenge:
verification uses OpenSSL's PKCS#1 padding validation and compares the recovered
bytes with the exact SHA-1 DigestInfo. It does not hash the challenge again or
accept arbitrary ASN.1 structures.

This is a local change to a development-tool dependency, not an application API.
`parsePublicKey` now returns a Node.js `KeyObject` with `verify`, `fingerprint`,
and `comment`; forge-specific `n`, `e`, `encrypt`, and custom verification
schemes are no longer exposed. The package declaration and README reflect this
tradeoff. Firefox tooling does not consume those forge-specific APIs. Node.js 22+
is already required by this repository. The upstream Apache-2.0 license remains
unchanged in the patched package.

Run `pnpm test:dependencies` to exercise the installed patch through both Firefox
tooling dependency paths, including Android authentication and CLI conversions.
