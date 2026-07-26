# Helper Release Checklist

Use this checklist for every coordinated helper release. A candidate is
identified by all four values below; a clean result for any other build does
not apply.

| Field | Required value |
| --- | --- |
| Release tag | `v___.___.___` |
| Release Candidate workflow run ID | `________________` |
| `SHA256SUMS.txt` SHA-256 | `________________________________________________________________` |
| Source commit | `________________________________________` |

## Before candidate creation

- [ ] The release tag exists in this repository and points to the reviewed source commit.
- [ ] Package versions match the release tag.
- [ ] The Windows code-signing policy records exactly one selected provider and one exact expected signer subject.
- [ ] The selected Windows provider has produced a successful test signature through the repository workflow.
- [ ] `WINDOWS_EXPECTED_SIGNER_SUBJECT` exactly matches the documented subject.
- [ ] The `windows-release-clearance` environment exists with at least one required reviewer.
- [ ] Signing credentials and identity material are stored only in the provider or repository secret store.
- [ ] Repository tests, browser tests, host tests, workflow validation, and packaging smoke tests pass.

## Immutable candidate checks

- [ ] The Release Candidate workflow completed successfully.
- [ ] The workflow summary records the run ID, tag, source commit, sorted artifact hashes, and `SHA256SUMS.txt` digest.
- [ ] The candidate artifact is named `helper-release-candidate` and has 90-day retention.
- [ ] No GitHub Release was created or modified during candidate assembly.
- [ ] `SHA256SUMS.txt` was generated after signing, notarization, stapling, and packaging.
- [ ] Every checksum entry verifies.
- [ ] The artifact allowlist contains exactly:

  - `chrome.zip`
  - `firefox.zip`
  - `firefox-sources.zip`
  - `tailscale-browser-ext-darwin-amd64`
  - `tailscale-browser-ext-darwin-arm64`
  - `tailchrome-helper-macos.pkg`
  - `tailscale-browser-ext-linux-amd64`
  - `tailscale-browser-ext-linux-arm64`
  - `tailchrome-helper-linux-amd64.deb`
  - `tailchrome-helper-linux-x86_64.rpm`
  - `tailscale-browser-ext-windows-amd64.exe`
  - `tailchrome-helper-windows-x64.msi`
  - `tailchrome-install.sh`
  - `SHA256SUMS.txt`

- [ ] Artifact attestations exist for the same final files.
- [ ] The macOS raw helpers and repair app pass `codesign --verify --deep --strict` and Gatekeeper assessment.
- [ ] The macOS package passes signature and stapling validation.
- [ ] The Linux raw helpers report the intended amd64 and arm64 architectures.
- [ ] The DEB and RPM contain only their declared system paths and no per-user install hook.
- [ ] The raw Windows EXE has one valid SHA-256 Authenticode signature, a timestamp, and the exact expected subject.
- [ ] The MSI-embedded EXE has the same signature requirements and SHA-256 as the raw EXE.
- [ ] The outer MSI has one valid SHA-256 Authenticode signature, a timestamp, and the same expected subject.
- [ ] The fixed Windows SDK SignTool and `Get-AuthenticodeSignature` both accept all three Windows signature layers.

## Exact-hash Windows security clearance

Record evidence outside the shipped product and compare it with the hashes in the waiting publication workflow.

| Check | EXE result | MSI result |
| --- | --- | --- |
| SHA-256 | `________________` | `________________` |
| Defender definition version/date | `________________` | `________________` |
| Defender static scan | `clean / blocked` | `clean / blocked` |
| Malwarebytes definition version/date | `________________` | `________________` |
| Malwarebytes static scan | `clean / blocked` | `clean / blocked` |
| Install/launch/use/repair/uninstall behavior | `clean / blocked` | `clean / blocked` |
| Behavioral detection | `none / blocked` | `none / blocked` |
| SmartScreen reputation prompt | `none / unknown reputation / detection` | `none / unknown reputation / detection` |

- [ ] Current Defender definitions and cloud protection were active.
- [ ] Current Malwarebytes definitions were active.
- [ ] Both final files were scanned before execution.
- [ ] The MSI installed for a standard user.
- [ ] Native-host initialization and one normal connection succeeded.
- [ ] Repair or reinstall succeeded.
- [ ] Uninstall removed registrations and runtime copies as documented.
- [ ] No malware, PUA, or behavioral detection occurred.
- [ ] Any ordinary signed SmartScreen unknown-reputation prompt is recorded for release notes or support, but is not described as malware.

If either scanner reports malware, PUA, or suspicious behavior, stop. Record the exact hash, detection name, definition version, vendor submission reference, determination, and same-hash retest. Do not approve publication while a determination is pending. A rebuild creates a new candidate and restarts every security check.

## Protected publication

- [ ] Dispatch `Publish Helper Release` with the original candidate run ID, release tag, and exact `SHA256SUMS.txt` digest.
- [ ] The workflow resolves a successful Release Candidate run from this repository and the expected workflow file.
- [ ] The run source commit is the supplied release tag commit.
- [ ] The original `helper-release-candidate` artifact is still available.
- [ ] Metadata, allowlist, checksums, Windows signatures, and macOS signatures revalidate.
- [ ] The protected reviewer compared Defender and Malwarebytes evidence with the exact hashes shown in the workflow summary.
- [ ] The protected reviewer approved `windows-release-clearance`.
- [ ] A retry byte-compared every existing draft asset and uploaded only missing files.
- [ ] No asset was overwritten with `--clobber`.
- [ ] The complete draft was downloaded and byte-compared with the candidate.
- [ ] The draft was made public only by the final publication step.

If the candidate artifact expires, or any file or digest differs, create a new candidate and repeat this checklist. Never rebuild, resign, repackage, regenerate checksums, or replace assets after clearance.
