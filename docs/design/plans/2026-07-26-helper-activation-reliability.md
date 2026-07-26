# Helper Activation Reliability Implementation Plan

**Goal:** Make helper setup and recovery dependable across supported platforms by distinguishing registration, permission, launch, runtime, and compatibility failures; keeping package installers primary; providing a verified per-user repair fallback; shipping a Linux ARM64 raw helper; and publishing Windows artifacts only after one stable publisher identity, valid signatures, and exact-artifact security checks are in place.

**Architecture:** Keep the native helper as the execution boundary. The extension observes native-messaging evidence, maps it to a typed failure category, and presents recovery steps that the evidence supports. Existing capability flags gate individual features; helper version differences only produce a non-blocking notice. Linux packages continue to own system files, while a version-pinned script provides an explicit per-user repair path after package discovery fails. The release workflow assembles immutable final candidates, verifies every signature and embedded payload, pauses for exact-hash security clearance, and only then publishes one coordinated release.

**Tech Stack:** TypeScript, Vitest, browser native messaging, Go 1.25, shell, PowerShell, WiX 6, nFPM, GitHub Actions, Apple Developer ID/notarization, and one selected Windows signing provider.

**Build invariant:** Every task that changes code ends with the focused tests for that seam plus `pnpm typecheck`, `pnpm test`, `go test -race ./...`, and `go vet ./...` where applicable. Cross-compilation and platform-specific packaging checks run before the task is considered complete.

**Release invariant:** No release asset is published unless the final raw Windows EXE, the exact EXE embedded in the MSI, and the outer MSI all have valid timestamped signatures from the selected publisher; all final artifact hashes are generated after signing/notarization; and the exact Windows candidates have passed the blocking Defender and Malwarebytes checks below. A normal signed SmartScreen unknown-reputation warning is disclosed but is not a blocking detection.

---

## Locked Decisions

These choices are part of the implementation contract:

1. This work improves helper activation and registration reliability. It does not replace the helper with an in-browser networking implementation or add a WASM execution tier.
2. Submit the SignPath Foundation and Azure Artifact Signing Individual applications in parallel. Prefer SignPath if it accepts the project, but select exactly one provider and publisher identity before the first signed release.
3. Do not retain a provider selector, automatic fallback, or alternating signing identities in the release workflow. Changing publisher later requires a separately reviewed migration.
4. Sign the raw Windows EXE before building the MSI. Build the MSI from that exact signed EXE, then sign the outer MSI. Missing, invalid, expired-at-signing, untimestamped, or unexpected-subject signatures block the whole release.
5. An actual Defender or Malwarebytes malware, PUA, or behavioral detection on a final signed EXE or MSI blocks the release. Submit the detected hash/artifact to the vendor, wait for a clean determination, update definitions, and retest the same hash.
6. A signed SmartScreen “unrecognized app” reputation prompt by itself does not block the release. Do not submit clean artifacts merely to seed reputation.
7. Keep Linux `.deb`/`.rpm` packages as the primary installation path. Packages own only their declared system files; no package post-install script may write per-user files.
8. Provide a hardened `scripts/install.sh` for macOS and Linux only as a fallback. Require an explicit release version, verify the downloaded artifact, invoke `-install-now`, and use the actual installed path for uninstall.
9. Do not cherry-pick `1ae2109` wholesale. Reuse ideas only after reconciling them with the current tree and the requirements in this plan.
10. Add a Linux ARM64 raw helper artifact and select architecture through `chrome.runtime.getPlatformInfo()`, not browser identification strings, WebGL, or browser-brand heuristics. Normalize Chromium's `arm64` and Firefox's `aarch64` platform-info values to one ARM64 tier. ARM64 `.deb`/`.rpm` packages are not part of this change.
11. After a package/install attempt and exhausted native-host discovery retries, make “Repair registration for this browser” prominent. The repair may call the helper’s existing tested user-scope registration table; the extension must not guess Brave, Vivaldi, Opera, or another Chromium brand from browser strings.
12. Do not add package-owned browser manifest paths unless a vendor or upstream source documents that system location and package removal owns the same file.
13. Restore and keep the signed `/Applications/Tailchrome Helper.app` repair entry point on macOS.
14. Replace `installError` and the generic disconnect treatment with the evidence-based failure model defined below. Primary UI copy must not claim a particular manifest defect, SmartScreen block, or antivirus action without evidence.
15. Raw native-messaging and helper errors appear only in the local diagnostic report after sanitization. User-facing recovery copy is category-based.
16. Diagnostics are user-initiated and local. Add copy and file-export actions, but no automatic submission, background telemetry, persistent tracking identifier, browsing data, traffic data, URLs, authentication data, tailnet identity, peer identity, or profile identity.
17. Remove the major/minor helper-version hard block. Version differences are non-blocking. Existing advertised capability flags continue to gate the individual features that need them.
18. Do not introduce a protocol version merely to replace the removed semantic-version check. `helper-incompatible` is set only by a future explicit structured protocol/capability incompatibility signal, never by a missing, unparsable, older, or newer helper version.
19. Do not add a helper self-updater. A version notice links to the selected release’s signed installer or repair instructions.
20. Do not add Winget, Homebrew, or new Linux repository publication in this change.
21. Deliver the implementation as one pull request and one coordinated release. The pull request may remain open and unmergeable while signing onboarding or final security validation is incomplete.

---

## Non-goals

- Zero-download or installerless operation.
- Reimplementing Tailscale networking inside the extension.
- Automatic diagnostic upload, crash reporting, analytics, or installation telemetry.
- Detecting a Chromium product/channel from `navigator.userAgent` and synthesizing a registration path.
- Expanding package-manager distribution beyond the existing GitHub Release assets.
- Automatically repairing system-wide registrations with elevated privileges.
- Treating code signing as proof that runtime behavior is safe.
- Guaranteeing that a newly signed Windows binary has established SmartScreen reputation.
- Supporting Linux architectures other than amd64 and arm64 in this change.
- Changing the existing macOS publisher identity or notarization model.

---

## Historical Baseline and Known Defects

This table records the pre-implementation state that motivated the work. It is
not a description of the current branch after the tasks below are applied.

| Area | Historical state | Required correction |
| --- | --- | --- |
| macOS repair app | `packaging/macos/TailchromeHelper.app/Contents/Info.plist` and `Contents/MacOS/tailchrome-helper` were deleted in this worktree during the installerless feasibility exploration and have been restored from `origin/main`. `build-pkg.sh` depends on them. | Keep both files intact and validate that the package contains a signed, launchable repair app. |
| Native-host errors | `native-host.ts` collapses not-found and forbidden errors into `install_error`; other early and late disconnects share generic handling. | Classify evidence into the six failure kinds below and preserve only sanitized diagnostic detail. |
| Helper compatibility | `background.ts` blocks on a major/minor mismatch through `hostVersionMismatch`, and the popup routes to `needs-update`. | Remove the blocking state/view; retain a non-blocking version notice and capability gates. |
| Linux release | `Makefile`, the popup, and `release.yml` publish only an amd64 raw helper. Existing `.deb`/`.rpm` packages are amd64-only. | Build, test, select, checksum, attest, and publish a Linux arm64 raw helper. Keep the existing package architectures unchanged in this scope. |
| Linux repair | Packages cover documented system locations. The raw binary is hidden as an advanced fallback and the UI hardcodes amd64. | Keep packages first; after discovery failure, offer a version-pinned architecture-aware user-scope repair. |
| Fallback script | No current `scripts/install.sh`; the orphaned version used mutable trust assumptions and an incorrect uninstall command. | Implement a new, tested script against current paths and release assets. |
| Windows signing | `release.yml` optionally reads a P12, silently skips signing, signs only the outer MSI, and publishes the original unsigned EXE. | Replace it with one selected provider, sign EXE before MSI construction, verify the embedded EXE and outer MSI, and fail closed. |
| Release staging | The main release job can create a draft before the macOS package and before external Windows security clearance. | Assemble every final candidate first, pause on a protected clearance gate, then publish all assets together. |
| Diagnostics | No focused helper-activation report exists. | Add bounded, sanitized, local copy/export diagnostics with explicit excluded data. |

Chrome’s Linux system native-messaging directory covers Chrome channels; do not add a separate package path for Chrome Beta. Treat the current Chrome, Chromium, Edge, and Firefox package paths as the verified baseline. Any proposed Brave, Vivaldi, Opera, or other package-owned system path needs a linked primary source and install/uninstall ownership tests before it enters this scope.

---

## State and Failure Contract

Replace the two blocking booleans with one source of truth:

```ts
export type HelperFailureKind =
  | "helper-unavailable"
  | "helper-not-allowed"
  | "helper-start-failed"
  | "helper-stopped"
  | "helper-reported-error"
  | "helper-incompatible";

export interface HelperFailure {
  kind: HelperFailureKind;
  diagnosticCode: string;
  diagnosticMessage: string | null;
}
```

`diagnosticMessage` is a bounded, sanitized, in-memory string. It is not rendered in normal recovery copy and is not persisted. Do not add random report IDs or attempt IDs to user-facing state. The retry scheduler may store only its source, next retry index, and absolute next deadline in `chrome.storage.session`.

Add:

```ts
helperFailure: HelperFailure | null;
helperVersionNotice: {
  installedVersion: string;
  releaseVersion: string;
  relation: "older" | "newer" | "different";
} | null;
repairRegistrationAvailable: boolean;
```

Classification is evidence-based:

| Evidence | Failure kind | Primary user message |
| --- | --- | --- |
| Browser says native host was not found / Firefox says no such native application | `helper-unavailable` | “Tailchrome could not find a registered helper for this browser.” |
| Browser says native host is forbidden or not allowed | `helper-not-allowed` | “This browser refused access to the registered helper.” |
| Port disconnects before the first valid helper message for any other reason | `helper-start-failed` | “The browser found the helper, but it stopped before setup completed.” |
| Port disconnects after at least one valid helper message | `helper-stopped` | “The helper stopped after connecting. Tailchrome is retrying.” |
| `procRunning.error` or `init.error` | `helper-reported-error` | “The helper started but reported a startup error.” |
| Future explicit structured protocol/capability incompatibility signal | `helper-incompatible` | “The helper and extension reported an incompatible protocol.” |

Rules:

- A successful helper message clears the connection failure and reconnect backoff.
- A successful `procRunning`/`init` sequence clears `repairRegistrationAvailable` in state and `chrome.storage.session`.
- Intentional disconnects do not create failures.
- Missing/unparseable versions do not create `helper-incompatible`.
- Version differences do not change `viewForState`, proxy behavior, or the warning badge.
- Capability flags remain false when omitted by an older helper. Only the related UI action is disabled or replaced with its existing update guidance.
- Firefox’s proxy gate treats unavailable, not-allowed, helper-reported, and explicit incompatible failures as authoritative. Start-failed and stopped-after-healthy remain transient behind the reconnect deadline.
- Package-attempt progress and the repair recommendation survive Manifest V3 service-worker suspension only in `chrome.storage.session`; they are not written to persistent local or sync storage.
- This pull request defines and renders `helper-incompatible` but does not produce it. Only a later, separately designed structured protocol/capability signal may set it.

---

## Diagnostic Report Contract

Generate the report only when the user clicks **Copy diagnostic report** or **Export diagnostic report**. Build it from current in-memory extension state plus `chrome.runtime.getPlatformInfo()` and `chrome.runtime.getManifest()`.

Allowed fields:

- report schema version;
- extension version;
- helper version, or `unknown`;
- extension release version, which is also the companion helper release version for that tag;
- OS and CPU architecture;
- browser build family (`chromium` or `firefox`), not inferred product brand;
- helper connection, initialization, and reconnecting booleans;
- failure kind and diagnostic code;
- bounded sanitized native/helper diagnostic message;
- advertised helper capability booleans;
- whether registration repair is available.

Explicitly excluded:

- visited URLs, current tab, referrers, history, cookies, and proxy destinations;
- control/login/auth URLs;
- tailnet name, MagicDNS suffix, Tailscale IPs, peers, profiles, user names, node IDs, and file-transfer details;
- traffic counters or payloads;
- extension profile ID;
- persistent report ID or automatic timestamped tracking record;
- credentials, tokens, filesystem home-directory names, and registry values containing user data.

Sanitization must:

- cap each retained message and the full report size;
- replace home-directory/user-profile path prefixes;
- remove URL-like strings and control characters;
- serialize from an allowlist rather than spreading `TailscaleState`;
- produce the same allowlisted data for clipboard and downloaded file.

The exported filename may be stable (for example, `tailchrome-helper-diagnostics.txt`); do not encode a user, profile, or tracking ID in it.

---

## File Structure

### Files restored

- `packaging/macos/TailchromeHelper.app/Contents/Info.plist` — repair app bundle metadata, already restored from `origin/main`; verified in Task 1.
- `packaging/macos/TailchromeHelper.app/Contents/MacOS/tailchrome-helper` — repair launcher with executable mode, already restored from `origin/main`; verified in Task 1.

### Files created

- `packages/shared/src/helper-diagnostics.ts` — shared allowlist, error sanitizer, redaction, size bounds, and pure report formatter (Task 3).
- `packages/shared/src/helper-diagnostics.test.ts` — sanitizer/report schema and sensitive-data exclusion tests (Task 3).
- `packages/shared/src/popup/helper-diagnostics.ts` — copy/export UI around the shared pure formatter (Task 3).
- `packages/shared/src/popup/helper-diagnostics.test.ts` — report content, redaction, size, copy, and export tests (Task 3).
- `scripts/install.sh` — pinned macOS/Linux per-user repair installer (Task 4).
- `scripts/install.test.sh` — hermetic shell tests with fixture downloads and stubbed tools (Task 4).
- `scripts/verify-windows-signatures.ps1` — publisher, timestamp, raw/embedded EXE identity, and MSI signature assertions (Task 5).
- `scripts/verify-windows-signatures.test.ps1` — local-certificate positive/negative verifier fixtures (Task 5).
- `.github/workflows/publish-helper-release.yml` — resumable protected publication of a previously cleared candidate run/digest (Task 6).
- `docs/WINDOWS_CODE_SIGNING_POLICY.md` — selected-provider policy, project roles, keyless/secret handling, and incident/revocation process (Tasks 0 and 7).
- `docs/RELEASE_CHECKLIST.md` — exact-candidate signing, security, platform smoke-test, and publication checklist (Tasks 6 and 7).

### Files modified

- `packages/shared/src/types.ts` — typed helper failure, version notice, repair state, and diagnostic-safe fields (Tasks 2–3).
- `packages/shared/src/__test__/fixtures.ts` — defaults for the replacement state fields (Tasks 2–3).
- `packages/shared/src/constants.ts` — remove the hard-gate-oriented helper version constant (Task 2).
- `packages/shared/src/background/native-host.ts` — classify disconnect evidence and emit structured connection events (Task 3).
- `packages/shared/src/background/background.ts` — remove semantic-version blocking, map helper-reported errors, own retry exhaustion, and clear failures on recovery (Tasks 2–3).
- `packages/shared/src/background/chrome-alarm-timer-service.ts` — rebind/recover named retry deadlines after a worker restart (Task 3).
- `packages/shared/src/background/state-store.ts` — replace legacy booleans and initialize the new state (Tasks 2–3).
- `packages/shared/src/background/badge-manager.ts` — warn on actionable helper failure, not version difference (Tasks 2–3).
- `packages/shared/src/popup/popup.ts` — remove `needs-update` routing and synchronize the non-blocking version notice/diagnostic actions (Tasks 2–3).
- `packages/shared/src/popup/views/needs-install.ts` — accept failure/repair state and render evidence-based package or repair entry points (Task 3).
- `packages/shared/src/popup/views/disconnected.ts` — category-specific recovery copy and diagnostics actions (Task 3).
- `packages/shared/src/popup/views/install-helpers.ts` — exact-version URLs, platform-info architecture, ARM64 assets, and package-first/repair modes (Tasks 2–4).
- `packages/shared/src/popup/styles/components.css` and `packages/shared/src/popup/styles/popup.css` — accessible notice, recovery, and diagnostic controls (Tasks 2–3).
- `packages/extension/src/background/firefox-proxy-manager.ts` — adapt authoritative/transient handling to structured failure kinds (Task 3).
- `packages/extension/src/background/chrome.ts` — rehydrate an active package retry on MV3 startup before handling due alarms (Task 3).
- `scripts/e2e/native-host.mjs` and `scripts/e2e/scenarios/connection-states.mjs` — typed failure fixtures and recovery scenarios (Task 3).
- `scripts/bump-version.sh` and `scripts/validate-release-tag.mjs` — stop maintaining/parsing the redundant helper version constant while retaining package/tag validation (Task 2).
- `package.json` — add the fallback-installer test command and include it in CI validation (Task 4).
- `Makefile` — add Linux ARM64 cross-build targets (Task 4).
- `packaging/windows/build-msi.ps1` — require and verify a signed EXE for release-quality MSI builds (Task 5).
- `.github/workflows/ci.yml` — add macOS package smoke coverage, installer shell tests, and workflow/static validation (Tasks 1 and 4–6).
- `.github/workflows/release.yml` — ARM64 assets, selected signing provider, immutable candidate assembly, fail-closed verification, clearance pause, and coordinated publication (Tasks 4–6).
- `README.md` — signing policy/acknowledgement plus package-first installation/repair guidance (Tasks 0 and 7).
- `docs/DOCUMENTATION.md` — state model, compatibility behavior, diagnostics, installation, release pipeline, and file tree (Task 7).
- `docs/FEATURE_PARITY.md` — non-blocking helper version and platform artifact coverage (Task 7).
- `docs/firefox-smoke-test.md` — replace obsolete version-gate expectations with capability and failure-state checks (Task 7).
- `docs/privacy-policy.md` — explicit local-only diagnostic behavior and excluded data (Task 7).
- `docs/SECURITY.md` — candidate clearance plus signed-release verification and false-positive reporting path (Tasks 6 and 7).
- `docs/CONTRIBUTING.md` — new focused tests and release prerequisites (Task 7).
- `packaging/linux/README.md` — Linux raw ARM64/repair behavior plus platform verification and uninstall instructions (Tasks 4 and 7).
- `packaging/macos/README.md` — macOS repair, verification, and uninstall instructions (Task 7).
- `packaging/windows/README.md` — provider decision plus Windows signing, repair, verification, and uninstall instructions (Tasks 0, 5, and 7).

### Files deleted

- `packages/shared/src/popup/views/needs-update.ts` — remove the obsolete blocking helper-version view after all callers and documentation are migrated (Task 2).

### Tests modified

- `packages/shared/src/background/native-host.test.ts`
- `packages/shared/src/background/background.test.ts`
- `packages/shared/src/background/chrome-alarm-timer-service.test.ts`
- `packages/shared/src/background/state-store.test.ts`
- `packages/shared/src/background/badge-manager.test.ts`
- `packages/shared/src/popup/popup.test.ts`
- `packages/shared/src/popup/views/disconnected.test.ts`
- `packages/shared/src/popup/views/connected.test.ts`
- `packages/shared/src/popup/views/install-helpers.test.ts`
- `packages/extension/src/background/firefox-proxy-manager.test.ts`
- `packages/extension/src/background/chrome.test.ts`

Do not modify `packaging/windows/Product.wxs` unless the implementation proves a WiX source change is required. It already embeds the `HelperExe` passed by `build-msi.ps1`; the release work must prove that input is the verified signed EXE.

---

## External Dependencies and Gate Ownership

These tracks can run while Tasks 1–4 are implemented, but they must resolve before merge/release.

| Gate | Mode | Owner | Required evidence | Blocking condition |
| --- | --- | --- | --- | --- |
| SignPath Foundation application | Manual | Project maintainer | Application accepted or rejected; repository policy/acknowledgement meets [SignPath Foundation conditions](https://signpath.org/terms.html) | Selection cannot finish while preferred provider status is unknown, unless the maintainer explicitly closes this path |
| Azure Artifact Signing Individual onboarding | Manual | Project maintainer | Identity/business validation, billing, signing account, certificate profile, endpoint, and successful test signature using the [official integration](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations) | Azure cannot be selected until its certificate profile signs and timestamps a test artifact |
| Stable provider selection | Manual decision recorded in PR/docs | Project maintainer | Selected provider, expected signer subject, timestamp service, and workflow authentication recorded | More than one enabled provider, a workflow input that switches provider, or an undefined expected subject |
| SignPath policy preparation | Repository change | Implementer/maintainer | Code-signing policy, roles, privacy link, and exact required acknowledgement when SignPath is used | Missing required public policy/acknowledgement for a SignPath-backed release |
| Windows workflow authentication | Automated + repository configuration | Maintainer | OIDC or provider-required project credentials work from GitHub-hosted runners; no private signing key committed | Long-lived signing key in the repository or a signing step that can silently skip |
| Defender final-candidate check | Manual clean VM plus recorded hash/result | Release reviewer | Current definitions/cloud protection, final EXE/MSI hashes, scan result, install/launch/use/uninstall result | Malware, PUA, or behavioral detection |
| Malwarebytes final-candidate check | Manual clean VM plus recorded hash/result | Release reviewer | Current definitions, final EXE/MSI hashes, scan result, install/launch/use/uninstall result | Malware, PUA, or behavioral detection |
| False-positive resolution | Manual vendor process | Maintainer | Final clean vendor determination/submission reference and same-hash retest | Detection remains, determination is pending, or rebuilt hash has not been retested |
| Protected publication approval | GitHub Environment approval | Release reviewer | Candidate manifest reviewed; signatures and both security results match the exact hashes in the waiting workflow run | Missing evidence or candidate hashes changed |

Provider implementation notes:

- Prefer the [SignPath GitHub trusted-build integration](https://docs.signpath.io/trusted-build-systems/github), `signpath/github-action-submit-signing-request@v2`, and an explicit [artifact configuration](https://docs.signpath.io/artifact-configuration/) if SignPath is selected. Keep every upstream build job on GitHub-hosted runners and preserve required manual signing approval.
- If Azure is selected, use `azure/login@v3` plus the maintained [`azure/artifact-signing-action@v2`](https://github.com/Azure/artifact-signing-action), OIDC, `id-token: write`, provider endpoint/signing-account/certificate-profile configuration, SHA-256 digesting, and RFC 3161 timestamping through `http://timestamp.acs.microsoft.com`. Do not use a certificate-file fallback.
- The final workflow contains only the selected provider. Delete the unselected integration branch before merge.
- If SignPath-specific acknowledgement was added for application review but Azure is ultimately selected and SignPath is not providing signing, make the public text factually match the selected service before merge.

---

## Task 0: Start both signing onboarding tracks and define the selection gate

This task is operational and documentation-first. It must not put credentials or identity documents in the repository. Implementation may continue while applications are pending.

**Files:**

- Create: `docs/WINDOWS_CODE_SIGNING_POLICY.md`
- Modify: `README.md`
- Modify: `packaging/windows/README.md`
- Modify: `docs/privacy-policy.md` only if the public signing-policy link needs an explicit cross-reference

- [ ] **Step 1: Submit both provider applications**

Submit SignPath Foundation and Azure Artifact Signing Individual onboarding using the project’s real maintainer identity and public repository information. Store identity documents, billing details, and credentials only in the provider/account systems.

Expected: both applications have trackable status outside the repository; no sensitive material appears in git.

- [ ] **Step 2: Add the public code-signing policy**

Document:

- project homepage and source repository;
- release artifact locations;
- maintainer, developer, signing submitter, and signing approver roles;
- the requirement that reviewed repository source and GitHub-hosted builds are the signing source;
- selected-provider authentication and secret boundaries;
- expected Windows signer subject;
- timestamping and signature-verification requirements;
- compromise, revocation, and publisher-migration procedure;
- privacy-policy link;
- SignPath’s required acknowledgement — `Free code signing provided by SignPath.io, certificate by SignPath Foundation` — on the project home/download surfaces if SignPath is providing the signing service.

If SignPath is selected, place that acknowledgement beside README download guidance and have the publish workflow include it in the GitHub Release body; the policy document alone is not the project home/download surface.

Expected: a reviewer can determine who may submit/approve signing, which build is eligible, and what happens on compromise without needing private account details.

- [ ] **Step 3: Record the provider decision**

Prefer SignPath after acceptance and a successful test request. Otherwise select Azure after successful Individual onboarding. Record one selected provider and exact expected signer subject in the policy and Windows packaging documentation.

Expected: one provider is selected; the other is absent from production workflow code; no manual workflow input can change publisher.

- [ ] **Step 4: Keep the pull request gated**

Add the unresolved provider selection and successful test signature to the pull-request checklist. Do not merge based only on submitted applications.

Expected: the pull request may remain open, but unsigned or identity-ambiguous release behavior cannot reach `main`.

---

## Task 1: Verify and protect the macOS repair app

The two tracked bundle files were restored from `origin/main` after the installerless feasibility exploration deleted them in this worktree. Verify them before touching the packaging flow, and add CI coverage so a future deletion fails pull-request CI. Preserve unrelated worktree changes.

**Files:**

- Verify: `packaging/macos/TailchromeHelper.app/Contents/Info.plist`
- Verify: `packaging/macos/TailchromeHelper.app/Contents/MacOS/tailchrome-helper`
- Modify: `.github/workflows/ci.yml`
- Test: existing `packaging/macos/build-pkg.sh`

- [ ] **Step 1: Verify the restored bundle files match `origin/main`**

The worktree deletion has already been reverted with `git restore --source=origin/main`. Confirm nothing drifted:

```bash
git diff --exit-code origin/main -- \
  packaging/macos/TailchromeHelper.app/Contents/Info.plist \
  packaging/macos/TailchromeHelper.app/Contents/MacOS/tailchrome-helper
```

Expected: both paths match `origin/main` byte for byte, the launcher retains executable mode, and no other worktree path changes.

- [ ] **Step 2: Validate the restored sources**

```bash
plutil -lint packaging/macos/TailchromeHelper.app/Contents/Info.plist
bash -n packaging/macos/TailchromeHelper.app/Contents/MacOS/tailchrome-helper
bash -n packaging/macos/build-pkg.sh packaging/macos/scripts/postinstall
test -x packaging/macos/TailchromeHelper.app/Contents/MacOS/tailchrome-helper
```

Expected: the plist and scripts validate and the launcher is executable.

- [ ] **Step 3: Build and inspect an unsigned local package**

```bash
VERSION=0.0.0 ./packaging/macos/build-pkg.sh
pkgutil --payload-files dist/tailchrome-helper-macos.pkg
```

Expected: the payload includes `/Applications/Tailchrome Helper.app`, its launcher, and the universal helper binary.

- [ ] **Step 4: Add release verification for the signed app**

In the macOS release job, expand or install the final package in a temporary root and run:

```bash
codesign --verify --deep --strict --verbose=2 "Tailchrome Helper.app"
spctl --assess --type execute --verbose=2 "Tailchrome Helper.app"
pkgutil --check-signature tailchrome-helper-macos.pkg
```

Expected: the final package and embedded repair app validate under the existing Apple identity. The app launches the installed system helper with `-install-now`.

- [ ] **Step 5: Add a macOS pull-request package smoke job**

On `macos-latest`, run the Step 2 source checks, build `VERSION=0.0.0 ./packaging/macos/build-pkg.sh`, expand the package into a temporary directory, and assert that `/Applications/Tailchrome Helper.app` and its executable launcher are present. This job does not need release signing credentials.

Expected: deleting or breaking the repair app fails pull-request CI instead of waiting for a release tag.

- [ ] **Step 6: Run the host suite**

```bash
(cd host && go test -race ./... && go vet ./...)
```

Expected: all Go tests and vet checks pass.

- [ ] **Step 7: Commit the plan and CI protection as part of the single feature branch**

The bundle files already match `origin/main`, so they carry no diff; commit the plan document and the new CI smoke coverage:

```bash
git add \
  docs/design/plans/2026-07-26-helper-activation-reliability.md \
  .github/workflows/ci.yml
git commit -m "Protect macOS helper repair app in CI"
```

Expected: one focused commit exists inside the eventual single pull request.

---

## Task 2: Replace version blocking with capability-driven compatibility

Keep package/tag alignment for build/release hygiene, but remove the redundant helper-version constant and all runtime compatibility gating.

**Files:**

- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/__test__/fixtures.ts`
- Modify: `packages/shared/src/background/background.ts`
- Modify: `packages/shared/src/background/state-store.ts`
- Modify: `packages/shared/src/background/badge-manager.ts`
- Modify: `packages/shared/src/popup/popup.ts`
- Modify: `packages/shared/src/popup/views/install-helpers.ts`
- Modify: `packages/shared/src/popup/styles/components.css`
- Delete: `packages/shared/src/popup/views/needs-update.ts`
- Modify: `scripts/bump-version.sh`
- Modify: `scripts/validate-release-tag.mjs`
- Modify: `scripts/e2e/native-host.mjs`
- Modify: `scripts/e2e/scenarios/connection-states.mjs`
- Test: relevant shared tests and E2E state fixtures

- [ ] **Step 1: Rewrite tests around the desired compatibility behavior**

Add cases proving:

- older, newer, missing, and unparsable helper versions never route to a blocking update view;
- a valid differing version produces only `helperVersionNotice`;
- a matching version clears the notice;
- a helper with omitted capabilities still connects and only unsupported controls are gated;
- a helper advertising one capability enables only that feature;
- version difference alone does not produce a warning badge or stop Firefox proxy recovery;
- only an explicit structured incompatibility signal may create `helper-incompatible`.

Run the focused tests and confirm they fail against the old model:

```bash
pnpm --filter @tailchrome/shared exec vitest run \
  src/background/background.test.ts \
  src/background/badge-manager.test.ts \
  src/popup/popup.test.ts \
  src/popup/views/connected.test.ts \
  src/popup/views/install-helpers.test.ts
pnpm --filter @tailchrome/extension exec vitest run \
  src/background/firefox-proxy-manager.test.ts
```

Expected: new assertions fail because `hostVersionMismatch` still blocks.

- [ ] **Step 2: Remove the redundant helper version constant**

Delete `EXPECTED_HOST_VERSION`. Use `chrome.runtime.getManifest().version` as the extension/companion release version for the non-blocking notice and exact release-asset URLs. Update `bump-version.sh` so it only updates the extension/shared package versions. Update `validate-release-tag.mjs` so the release tag still must match those package versions; the Go helper itself is stamped from the release tag.

Expected: build-time package/tag consistency remains fail-closed with no third manually synchronized version source.

- [ ] **Step 3: Remove the blocking version state and view**

Remove:

- `hostVersionMismatch`;
- `isVersionMismatch`;
- `"needs-update"` routing and rendering;
- version mismatch from badge priority;
- retry logic that reconnects solely because versions differ;
- `needs-update.ts`.

Add a pure comparison between the helper-reported version and `chrome.runtime.getManifest().version` that returns a non-blocking notice only. If versions cannot be compared, keep the helper connected and record `unknown` only in diagnostics.

Expected: all backend/login/running views remain reachable with a different helper version.

- [ ] **Step 4: Render the notice without taking over the popup**

The notice must:

- state installed and companion release versions;
- distinguish older/newer/different only when safely parseable;
- when the helper is older, link to the exact signed companion package release or repair guidance;
- when the helper is newer/different, link to release/troubleshooting information without offering a downgrade;
- be dismissible for the current popup session;
- never automatically download or install.

Expected: normal controls remain usable underneath the notice.

- [ ] **Step 5: Keep feature checks capability-based**

Retain and test `supportsNetcheck`, `supportsPingPeer`, `supportsLogin`, and `supportsCustomControlURL`. Do not add a protocol number until a concrete breaking protocol change is designed.

Expected: an older helper remains useful for every feature it advertises.

- [ ] **Step 6: Run focused and full TypeScript validation**

```bash
pnpm --filter @tailchrome/shared exec vitest run \
  src/background/background.test.ts \
  src/background/badge-manager.test.ts \
  src/popup/popup.test.ts \
  src/popup/views/connected.test.ts \
  src/popup/views/install-helpers.test.ts
pnpm --filter @tailchrome/extension exec vitest run \
  src/background/firefox-proxy-manager.test.ts
pnpm typecheck
pnpm test
pnpm e2e:full:chrome
pnpm e2e:full:firefox
```

Expected: all tests pass with no reference to `hostVersionMismatch` or the `needs-update` view, and version difference never replaces a normal browser view.

- [ ] **Step 7: Commit the compatibility change**

```bash
git add packages/shared scripts/bump-version.sh scripts/validate-release-tag.mjs
git commit -m "Make helper compatibility capability-driven"
```

Expected: one focused commit exists inside the same pull request.

---

## Task 3: Add typed helper failures, tailored recovery, and local diagnostics

Move classification into the native-host connection boundary, then let background state and the popup consume a typed result. Keep browser/helper strings out of primary UI.

**Files:**

- Create: `packages/shared/src/helper-diagnostics.ts`
- Create: `packages/shared/src/helper-diagnostics.test.ts`
- Create: `packages/shared/src/popup/helper-diagnostics.ts`
- Create: `packages/shared/src/popup/helper-diagnostics.test.ts`
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/__test__/fixtures.ts`
- Modify: `packages/shared/src/background/native-host.ts`
- Modify: `packages/shared/src/background/background.ts`
- Modify: `packages/shared/src/background/chrome-alarm-timer-service.ts`
- Modify: `packages/shared/src/background/state-store.ts`
- Modify: `packages/shared/src/background/badge-manager.ts`
- Modify: `packages/shared/src/popup/popup.ts`
- Modify: `packages/shared/src/popup/views/needs-install.ts`
- Modify: `packages/shared/src/popup/views/disconnected.ts`
- Modify: `packages/shared/src/popup/views/install-helpers.ts`
- Modify: `packages/shared/src/popup/styles/components.css`
- Modify: `packages/shared/src/popup/styles/popup.css`
- Modify: `packages/extension/src/background/firefox-proxy-manager.ts`
- Modify: `packages/extension/src/background/chrome.ts`
- Modify: `scripts/e2e/native-host.mjs`
- Modify: `scripts/e2e/scenarios/connection-states.mjs`
- Test: all files listed in “Tests modified”

- [ ] **Step 1: Write failure-classification tests first**

Cover Chrome and Firefox variants for:

- not found/no such application → unavailable;
- forbidden/not allowed → not allowed;
- a synchronous `chrome.runtime.connectNative()` throw → start failed with sanitized diagnostics;
- an initial `port.postMessage(init)` throw → start failed with sanitized diagnostics;
- empty/malformed/unrecognized port messages → ignored for health classification and retained only as a bounded diagnostic code;
- empty/unknown disconnect before first message → start failed;
- disconnect after a valid message → stopped;
- `procRunning.error` and `init.error` → reported error;
- intentional disconnect → no failure;
- first healthy message → clear prior connection failure and reset backoff;
- semantic-version difference → never incompatible;
- no current native reply or disconnect path ever produces incompatible.

```bash
pnpm --filter @tailchrome/shared exec vitest run \
  src/background/native-host.test.ts \
  src/background/background.test.ts \
  src/background/chrome-alarm-timer-service.test.ts
pnpm --filter @tailchrome/extension exec vitest run \
  src/background/chrome.test.ts \
  src/background/firefox-proxy-manager.test.ts
```

Expected: the new typed assertions fail while `install_error` still exists.

- [ ] **Step 2: Emit structured native connection events**

Replace the boolean-only state callback/synthetic `install_error` message with a discriminated connection event. Define a valid helper envelope as an object containing at least one recognized `NativeReply` field with the expected top-level shape; an arbitrary object must not mark the port healthy. Use the resulting “has received a valid message” state to distinguish start failure from later stop. Convert synchronous `connectNative()` and initial `postMessage(init)` exceptions into the same start-failed event. Preserve the raw browser string only long enough to sanitize and bound it, and do not write an unredacted copy to normal console logs.

Classifier matching must be case-insensitive and covered by exact browser-message fixtures. Put narrow known phrases before the generic pre-first-message fallback.

Expected: the connection class owns browser error interpretation; background code does not parse browser strings.

- [ ] **Step 3: Replace `installError` throughout state**

Use `helperFailure` and `repairRegistrationAvailable` in the state store, background transitions, badge manager, popup router, fixtures, and Firefox proxy manager.

State transition requirements:

- connection failures never overwrite a more specific helper-reported error from the same attempt;
- reconnecting can coexist with `helper-start-failed` and `helper-stopped`, but not with an unavailable, not-allowed, helper-reported, or explicit incompatible result;
- successful `procRunning` and `init` clear failure/repair state;
- disconnect clears stale capability flags only when the connection is truly gone;
- package retry polling stops when healthy and promotes repair only after the final unsuccessful retry.
- replace the unqualified retry message with `{ type: "retry-native-host", source: "package" | "fallback" | "manual" }`;
- persist `{ source, nextRetryIndex, nextRetryAt }` plus the eventual repair recommendation in `chrome.storage.session` so worker suspension does not reset the flow, and clear it on recovery;
- on MV3 startup/alarm wake, rehydrate the record before scheduling; if `nextRetryAt` is already due, execute that retry once, otherwise re-arm the remaining delay. Test this with a fresh background/timer instance between retry steps;
- make the disconnected **Retry Connection** button send a manual native-host retry instead of the unrelated `toggle` command.

Every `NativeReply.error` path must pass through the shared sanitizer. Connection/init/process-start errors become the typed helper failure above. Other command errors use curated command-specific primary copy; their sanitized raw detail is available only to diagnostics and must not be assigned directly to `state.error` or a normal toast.

Expected: there is one failure source of truth and no remaining `installError` or `"install_error"` strings.

- [ ] **Step 4: Add evidence-based recovery UI**

Route unavailable/not-allowed failures into package/repair setup. Keep start-failed, stopped, and reported-error recovery in the disconnected view. Render defensive incompatible copy for a future explicit structured signal, but do not add a producer or protocol field in this pull request.

Actions by category:

| Failure | Primary action | Secondary action |
| --- | --- | --- |
| unavailable before install attempt | Download signed platform package | Retry discovery |
| unavailable after retry exhaustion | Repair registration for this browser | Reinstall signed package |
| not allowed | Repair registration | Open diagnostics |
| start failed | Retry helper | Reinstall/repair, then diagnostics |
| stopped | Automatic/manual reconnect | Diagnostics |
| reported error | Retry after reviewing safe guidance | Diagnostics |
| incompatible | Download signed compatible installer | Diagnostics |

Do not mention SmartScreen, antivirus, or an exact manifest path in category copy.

Expected: each failure presents an action supported by observed evidence.

- [ ] **Step 5: Add the shared sanitizer and local copy/export diagnostics**

Put the allowlist, redaction, bounds, and pure report formatter in `packages/shared/src/helper-diagnostics.ts` so native-host/background code can sanitize before storing state without importing popup code. Keep DOM, clipboard, and export behavior in the popup module. Use `chrome.runtime.getPlatformInfo()` for OS/architecture and a Blob/object URL plus an `<a download>` click for export, so no `downloads` permission is needed. Revoke the object URL after use.

Add tests that seed state with URLs, tailnet, peers, profile IDs, auth data, home paths, and oversized error text, then prove none leaks into the report.

```bash
pnpm --filter @tailchrome/shared exec vitest run \
  src/helper-diagnostics.test.ts \
  src/popup/helper-diagnostics.test.ts \
  src/popup/views/disconnected.test.ts \
  src/popup/views/install-helpers.test.ts
```

Expected: copy and export contain identical allowlisted content; excluded data and unredacted paths/URLs are absent.

- [ ] **Step 6: Update E2E native-host fixtures**

Add deterministic fixture controls for each failure kind and recovery after retry. Test that:

- correct safe copy appears;
- raw fixture text appears only in a generated diagnostic report;
- successful reconnect returns to the normal state;
- version difference does not replace the normal view.

```bash
pnpm e2e:full:chrome
pnpm e2e:full:firefox
```

Expected: both browser suites cover unavailable, early failure, late stop, recovery, and non-blocking version notice.

- [ ] **Step 7: Run full validation and commit**

```bash
pnpm typecheck
pnpm test
(cd host && go test -race ./... && go vet ./...)
git diff --check
```

Expected: all validation passes and the diff is whitespace-clean.

```bash
git add packages/shared packages/extension scripts/e2e
git commit -m "Classify helper failures and add local diagnostics"
```

Expected: one focused commit exists inside the same pull request.

---

## Task 4: Add a Linux ARM64 raw helper and a hardened per-user repair fallback

Make raw repair downloads architecture-correct. Keep the existing amd64 system packages primary where compatible, route Linux arm64 to the verified raw helper, and keep user-scope registration explicit.

**Files:**

- Create: `scripts/install.sh`
- Create: `scripts/install.test.sh`
- Modify: `Makefile`
- Modify: `package.json`
- Modify: `packaging/linux/README.md`
- Modify: `packages/shared/src/popup/views/install-helpers.ts`
- Modify: `packages/shared/src/popup/views/install-helpers.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add failing asset-selection and script tests**

Test the popup matrix:

| OS | Browser arch | Primary assets | Raw repair artifact |
| --- | --- | --- | --- |
| Linux | `x86-64` | amd64 `.deb`, x86_64 `.rpm` | linux-amd64 |
| Linux | `arm64`/`aarch64` | verified raw helper; do not show incompatible amd64 packages | linux-arm64 |
| macOS | `x86-64` | universal `.pkg` | darwin-amd64 |
| macOS | `arm64`/`aarch64` | universal `.pkg` | darwin-arm64 |
| Windows | `x86-64` | x64 `.msi` | signed windows-amd64 EXE |
| Windows | `arm64`/`aarch64` | x64 `.msi`, noting it runs under x64 emulation | signed windows-amd64 EXE |

Chromium reports the ARM64 tier as `arm64`; Firefox reports it as `aarch64` (its `PlatformArch` enum has no `arm64`). Normalize both values to one ARM64 tier before asset selection, and mock both in the tests. Use mocked `chrome.runtime.getPlatformInfo()`; delete WebGL and browser-string architecture probing.

Add hermetic shell cases for:

- supported OS/architecture mapping;
- unsupported OS/architecture rejection;
- explicit `vX.Y.Z` version requirement;
- HTTPS/tag-pinned URL construction;
- missing `curl`;
- missing both `sha256sum` and `shasum`;
- missing or duplicate checksum entry;
- checksum mismatch;
- optional attestation success/failure when `gh` is present;
- download failure;
- `-install-now` failure;
- correct installed-path uninstall on Linux/macOS;
- cleanup of temporary files.

```bash
pnpm --filter @tailchrome/shared exec vitest run \
  src/popup/views/install-helpers.test.ts
bash scripts/install.test.sh
```

Expected: new ARM64 and hardening assertions fail before implementation.

- [ ] **Step 2: Add Linux ARM64 cross-builds**

Add `host-linux-arm64` and include it in `host-all`:

```bash
make host-linux-amd64 host-linux-arm64
file dist/tailscale-browser-ext-linux-amd64
file dist/tailscale-browser-ext-linux-arm64
go version -m dist/tailscale-browser-ext-linux-amd64
go version -m dist/tailscale-browser-ext-linux-arm64
```

Expected: both are statically cross-built for the intended architecture with the release version metadata path intact.

- [ ] **Step 3: Preserve and verify the package ownership boundary**

Keep the existing package outputs unchanged:

- `tailchrome-helper-linux-amd64.deb`
- `tailchrome-helper-linux-x86_64.rpm`

The package contents remain:

- `/usr/lib/tailchrome/tailscale-browser-ext`;
- the currently verified Chrome, Chromium, Edge, and Firefox system manifests;
- no post-install script and no file below a user home directory.

Inspect both existing package formats in Linux CI:

```bash
dpkg-deb --info dist/tailchrome-helper-linux-amd64.deb
dpkg-deb --contents dist/tailchrome-helper-linux-amd64.deb
rpm -qip dist/tailchrome-helper-linux-x86_64.rpm
rpm -qlp dist/tailchrome-helper-linux-x86_64.rpm
```

Expected: package manifests contain no user-scope path or maintainer registration script. No ARM package is introduced or advertised.

- [ ] **Step 4: Implement the pinned repair script**

The script interface is:

```text
scripts/install.sh --version vX.Y.Z [--uninstall]
```

Publish the same reviewed file as the release asset `tailchrome-install.sh`; the popup/docs link to that exact asset under the extension’s release tag.

Keep `scripts/install.sh` and `scripts/install.test.sh` executable in git.

Install behavior:

1. Reject absent/non-semver version.
2. Map Darwin/Linux plus amd64/arm64 to one exact release filename.
3. Require `curl` and either `sha256sum` or `shasum`.
4. Download the artifact and `SHA256SUMS.txt` from the exact `releases/download/vX.Y.Z/` URL over HTTPS into `mktemp -d`.
5. Extract exactly one checksum line whose filename exactly matches the chosen artifact; reject missing/duplicate/unsafe entries.
6. Verify SHA-256 before chmod or execution.
7. If `gh` is available, verify GitHub artifact attestation for `dantraynor/tailchrome` and stop if verification fails; if `gh` is unavailable, print a concise warning that the checksum and artifact share the GitHub Release trust boundary.
8. Execute the verified temporary artifact with `-install-now`.
9. Print the actual installed path and exact uninstall command.
10. Remove the temporary directory through a trap on success or failure.

Uninstall behavior invokes:

- Linux: `$HOME/.local/share/tailscale/browser-ext/tailscale-browser-ext -uninstall`
- macOS: `$HOME/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext -uninstall`

Do not present `curl ... | sh` as the default. Documentation/UI must show download, checksum/attestation verification, inspection, then execution.

Expected: the script never executes unverified bytes and never assumes `tailscale-browser-ext` is on `PATH`.

- [ ] **Step 5: Promote repair only after discovery failure**

Use the existing background-owned retry schedule. On amd64, the package CTA starts discovery retries before opening the download. If retries exhaust with unavailable/not-allowed state:

- set `repairRegistrationAvailable`;
- finish the session-backed retry record and store the recommendation in `chrome.storage.session`;
- show the prominent repair action;
- use exact release URLs and the runtime platform architecture;
- explain that the repair writes current-user registration;
- retain the signed package as the reinstall option.

On Linux arm64, do not show amd64 `.deb`/`.rpm` links; present the version-pinned verified raw helper as the supported path immediately. The extension must not infer a Chromium product name. The helper’s existing `-install-now` target table remains the user-scope authority.

Expected: compatible Linux users see packages first; arm64 users never receive an incompatible package; users whose installed package is not discovered receive a concrete per-user recovery path.

- [ ] **Step 6: Add the Linux ARM64 raw asset to CI/release staging**

Upload the raw Linux arm64 helper, include it in candidate assembly, checksums, attestations, and release summaries. Assert the expected asset matrix before candidate upload so a missing raw architecture fails the job.

Expected: Linux amd64 and arm64 raw helpers are handled identically from build through release; package outputs remain amd64/x86_64 only.

- [ ] **Step 7: Run focused/full validation and commit**

```bash
bash -n scripts/install.sh scripts/install.test.sh packaging/linux/build-packages.sh
bash scripts/install.test.sh
make host-all
pnpm typecheck
pnpm test
(cd host && go test -race ./... && go vet ./...)
git diff --check
```

Expected: all checks pass and both Linux raw binaries exist.

Add [ShellCheck v0.11.0](https://github.com/koalaman/shellcheck/releases/tag/v0.11.0) as an explicit CI pin (for example, the `koalaman/shellcheck:v0.11.0` container) over `scripts/install.sh`, `scripts/install.test.sh`, and `packaging/linux/build-packages.sh`. A local `shellcheck` run is optional; do not require a global install merely to run the rest of the suite.

```bash
git add \
  Makefile package.json scripts/install.sh scripts/install.test.sh \
  packaging/linux/README.md packages/shared/src/popup/views/install-helpers.ts \
  packages/shared/src/popup/views/install-helpers.test.ts \
  .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "Add Linux ARM64 and verified registration repair"
```

Expected: one focused commit exists inside the same pull request.

---

## Task 5: Integrate one fail-closed Windows signing provider

Do this task only after Task 0 has selected a provider and exact signer subject. Signing order is part of the security boundary.

**Files:**

- Create: `scripts/verify-windows-signatures.ps1`
- Create: `scripts/verify-windows-signatures.test.ps1`
- Modify: `packaging/windows/build-msi.ps1`
- Modify: `packaging/windows/README.md`
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add signature verifier tests/negative fixtures**

The PowerShell verifier accepts:

- path to final raw EXE;
- path to final MSI;
- expected signer subject;
- optional extraction directory.

It must fail for unsigned files, invalid signatures, absent timestamps, unexpected subjects, multiple ambiguous signer results, missing embedded EXE, or an embedded EXE whose SHA-256 differs from the signed raw release EXE.

Use locally generated test certificates only for verifier tests. Never make a test certificate acceptable in release mode.

Run in a credential-free Windows CI job:

```powershell
pwsh -NoProfile -File .\scripts\verify-windows-signatures.test.ps1
```

Expected: negative fixtures fail and a locally signed fixture pair passes only with its exact test subject. The job needs no production signing credentials.

- [ ] **Step 2: Make signing configuration mandatory**

Remove:

- `WINDOWS_CODESIGN_P12_BASE64`;
- `WINDOWS_CODESIGN_PASSWORD`;
- the “Skipping Windows signing” branch;
- every path that uploads the original unsigned build EXE.

Grant only the permissions required by the selected provider. Prefer OIDC where supported. Provider credentials/configuration missing from the repository environment must fail before packaging.

Expected: release-quality Windows packaging cannot complete unsigned.

- [ ] **Step 3: Sign and verify the raw EXE first**

Required sequence:

1. Download the unsigned build EXE from the reviewed build job.
2. Submit it to the selected provider.
3. Receive a timestamped signed EXE into a separate `signed-windows` staging directory.
4. Verify Authenticode status, timestamp, SHA-256 digest algorithm, and exact signer subject.
5. Record its SHA-256.

Expected: the signed EXE, not the original build output, is the only Windows helper eligible for subsequent packaging/publication.

- [ ] **Step 4: Build the MSI from the verified signed EXE**

Pass the signed path explicitly:

```powershell
.\packaging\windows\build-msi.ps1 `
  -Version $env:RELEASE_TAG `
  -HelperExe .\signed-windows\tailscale-browser-ext-windows-amd64.exe `
  -OutPath .\signed-windows\tailchrome-helper-windows-x64.unsigned.msi
```

In release mode, `build-msi.ps1` must call `Get-AuthenticodeSignature` on `HelperExe` and reject any status/subject other than the configured expected values before invoking WiX. Unsigned local development builds remain possible only through an explicit development flag and can never be consumed by the release job.

Expected: WiX embeds the same verified signed EXE.

- [ ] **Step 5: Sign the outer MSI**

Submit the unsigned MSI to the same selected provider/identity and receive `tailchrome-helper-windows-x64.msi`.

Expected: the MSI and EXE signer subjects are the same stable expected identity and both signatures are timestamped.

- [ ] **Step 6: Verify the nested payload and outer package**

Run:

```powershell
.\scripts\verify-windows-signatures.ps1 `
  -RawExe .\signed-windows\tailscale-browser-ext-windows-amd64.exe `
  -Msi .\signed-windows\tailchrome-helper-windows-x64.msi `
  -ExpectedSignerSubject $env:WINDOWS_EXPECTED_SIGNER_SUBJECT
```

The verifier must perform an administrative extraction or equivalent non-executing MSI extraction, find `tailscale-browser-ext.exe`, verify its signature, and require its SHA-256 to equal the final raw EXE.

Install/use one fixed Windows SDK version in the release workflow, fail if that exact `signtool.exe` cannot be resolved, and run `signtool verify /pa /all /v` against both artifacts. Do not search for and accept an arbitrary first SDK installation. `Get-AuthenticodeSignature` is an additional structured check, not a substitute for mandatory SignTool chain/digest/timestamp verification.

Expected: raw EXE, embedded EXE, and outer MSI are valid and tied to one expected subject.

- [ ] **Step 7: Upload one Windows artifact bundle**

Upload only:

- signed raw EXE;
- signed MSI;
- signature-verification JSON/text summary containing hashes, signer subject, and timestamp result.

Set `release` to depend on this bundle. Never copy the Windows EXE from `build-output`.

Expected: unsigned Windows artifacts cannot enter release candidate assembly.

- [ ] **Step 8: Validate workflow syntax and commit**

```bash
git diff --check
```

Add and run the [actionlint v1.7.12](https://github.com/rhysd/actionlint/releases/tag/v1.7.12) CI pin with `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12` against:

```text
.github/workflows/ci.yml
.github/workflows/release.yml
```

Contributors with a local `actionlint` binary may use it, but CI is authoritative and does not require a global install.

Expected: workflow/static validation passes; a test workflow run reaches the selected provider and produces a valid test-signed artifact.

```bash
git add \
  scripts/verify-windows-signatures.ps1 scripts/verify-windows-signatures.test.ps1 \
  packaging/windows/build-msi.ps1 packaging/windows/README.md \
  .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "Require signed Windows release artifacts"
```

Expected: one focused commit exists inside the same pull request.

---

## Task 6: Assemble immutable candidates and enforce resumable security clearance

Move publication after every package has reached its final byte representation. Separate candidate creation from publication so a vendor review can outlive one waiting job without rebuilding or changing the cleared bytes.

**Files:**

- Create: `docs/RELEASE_CHECKLIST.md`
- Create: `.github/workflows/publish-helper-release.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `docs/SECURITY.md`

- [ ] **Step 1: Refactor the release job graph**

Use this two-phase dependency order:

```text
release.yml — candidate phase
build
  ├─ sign/package macOS
  ├─ package Linux
  └─ sign/package Windows
          ↓
assemble-release-candidate
          ↓
record run ID + source SHA/tag + SHA256SUMS digest

external exact-hash Defender/Malwarebytes clearance

publish-helper-release.yml — resume phase
workflow_dispatch(candidate run ID, release tag, SHA256SUMS digest)
          ↓
download original candidate artifact
          ↓
revalidate source/tag/digest/signatures
          ↓
windows-release-clearance (protected environment)
          ↓
create draft, upload exact files, complete release checklist
          ↓
publish draft
```

The macOS package job must upload its final notarized/stapled package as an artifact instead of uploading to GitHub Releases after a release job. The assembly job waits for every platform.

Expected: no GitHub Release exists or changes before all platform candidates and checks are complete.

- [ ] **Step 2: Assemble and verify the complete asset matrix**

Require the expected filenames for:

- Chrome, Firefox, and Firefox source ZIPs;
- signed/notarized Darwin amd64 and arm64 raw binaries;
- signed/notarized/stapled macOS package;
- Linux amd64 and arm64 raw binaries;
- Linux amd64 `.deb` and x86_64 `.rpm` packages;
- signed Windows amd64 raw EXE;
- signed Windows x64 MSI;
- `scripts/install.sh` published as `tailchrome-install.sh`.

Generate `SHA256SUMS.txt` only after collecting these exact final files. Generate attestations over the same set. Upload the entire directory once as an immutable workflow artifact with 90 days of retention, and print the candidate run ID, source commit/tag, sorted names/hashes, and SHA-256 of `SHA256SUMS.txt` in the workflow summary.

Expected: a missing, duplicate, or unexpected asset fails assembly.

- [ ] **Step 3: Run automated final-candidate checks**

Before the manual gate:

- rerun signature verification on downloaded Windows artifacts;
- validate macOS signatures/notarization/stapling;
- validate package metadata and architecture;
- verify every `SHA256SUMS.txt` entry against the assembled file;
- verify the fallback installer selects only filenames present in the matrix;
- verify attestations against the repository where supported.
- run a Defender custom scan of both signed Windows files in an environment with active, current Defender/cloud protection and fail on malware/PUA. If a GitHub-hosted runner cannot prove Defender is active, route this check to the controlled Windows validation environment; never turn a skipped scan into success.

Expected: the manual reviewer never receives a structurally invalid candidate.

- [ ] **Step 4: Test the exact Windows candidates in a clean VM**

With current Defender definitions, cloud protection, and Malwarebytes definitions:

1. Download the candidate artifact bundle from the waiting workflow.
2. Verify its checksum manifest.
3. Record EXE and MSI SHA-256 hashes.
4. Confirm the automated Defender result, then scan both files again with current Defender and Malwarebytes in the clean validation environment.
5. Install the MSI as a standard user.
6. Launch the extension/helper path and exercise native-host initialization and one normal connection.
7. Run repair/reinstall.
8. Uninstall and confirm browser registrations/runtime copies are removed as documented.
9. Scan again if behavior monitoring reports anything during execution.

Expected: no malware, PUA, or behavioral detection and the signed install/repair/uninstall lifecycle succeeds.

- [ ] **Step 5: Handle detections fail-closed**

For Defender, use the [Microsoft Security Intelligence submission portal](https://www.microsoft.com/en-us/wdsi/filesubmission) as a software developer. For Malwarebytes, follow its [false-positive reporting process](https://help.malwarebytes.com/hc/en-us/articles/31589211404571-Report-a-false-positive-to-Malwarebytes-Support).

Record outside the shipped product:

- exact detected hash;
- detection name and definition version;
- submission/reference ID;
- vendor determination;
- same-hash clean retest result.

Do not dispatch/approve publication while a determination is pending. A rebuild creates a new hash and restarts both vendor checks. If the candidate artifact expires before clearance, create a new candidate and repeat signature/security validation; never recreate bytes and claim the old result.

Expected: an actual detection cannot be waived by code signing or a clean result for an older build.

- [ ] **Step 6: Treat SmartScreen reputation separately**

Document the [SmartScreen reputation model](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation):

- verify the signature is valid before assessing the prompt;
- record an ordinary signed unknown-reputation prompt for release notes/support;
- do not block indefinitely on that prompt;
- do not submit a clean build as malware merely to request reputation;
- block only if SmartScreen/Defender reports an actual malicious/PUA classification or the signature is invalid.

Expected: reputation and detection are not conflated.

- [ ] **Step 7: Resume from and publish the same candidate bytes**

Dispatch `publish-helper-release.yml` with the original candidate run ID, release tag, and `SHA256SUMS.txt` digest. The workflow must:

1. Resolve the original run through the GitHub API and require a successful conclusion, expected source commit, and matching tag.
2. Download the named candidate artifact from that run; fail if it expired or is absent.
3. Recompute the manifest digest, every asset hash, signatures, and asset allowlist before requesting approval.
4. Ask the protected `windows-release-clearance` reviewer to compare the Defender/Malwarebytes evidence with those exact hashes.
5. Refuse `--clobber`. If the release tag does not exist, create one draft and upload all assets. If a draft already exists after a retry, download and byte-compare every existing asset; continue only when all existing hashes exactly match, then upload only missing assets.
6. Complete the coordinated checklist, then explicitly run `gh release edit "$RELEASE_TAG" --draft=false`.

Give the publish workflow only `actions: read` and `contents: write` plus the protected environment; reject run IDs from forks, another repository, the wrong workflow, or a source commit that is not the supplied release tag.

Expected: no rebuild, resign, repack, checksum regeneration, asset replacement, or silent update occurs after clearance; one coordinated release becomes public only at the terminal step.

- [ ] **Step 8: Commit the release gate**

```bash
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 \
  .github/workflows/ci.yml \
  .github/workflows/release.yml \
  .github/workflows/publish-helper-release.yml
git add \
  .github/workflows/release.yml .github/workflows/publish-helper-release.yml \
  docs/RELEASE_CHECKLIST.md docs/SECURITY.md
git commit -m "Gate releases on final artifact clearance"
```

Expected: one focused commit exists inside the same pull request.

---

## Task 7: Align installation, privacy, architecture, and release documentation

Update documentation after behavior and workflow names are final. Remove every stale claim about major/minor blocking, optional Windows signing, amd64-only Linux, and the obsolete update view.

**Files:**

- Modify: `README.md`
- Modify: `docs/DOCUMENTATION.md`
- Modify: `docs/FEATURE_PARITY.md`
- Modify: `docs/firefox-smoke-test.md`
- Modify: `docs/privacy-policy.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/CONTRIBUTING.md`
- Modify: `docs/WINDOWS_CODE_SIGNING_POLICY.md`
- Modify: `docs/RELEASE_CHECKLIST.md`
- Modify: `packaging/linux/README.md`
- Modify: `packaging/macos/README.md`
- Modify: `packaging/windows/README.md`

- [ ] **Step 1: Update user installation/recovery guidance**

Document:

- signed platform package as primary;
- exact amd64/arm64 Linux choices;
- when registration repair appears;
- version-pinned script download, inspection, checksum, optional attestation, and execution;
- macOS `/Applications/Tailchrome Helper.app`;
- Windows signed MSI repair;
- actual per-platform uninstall paths;
- no `curl | sh` recommendation.

Expected: a user can install, repair, verify, and uninstall without guessing paths.

- [ ] **Step 2: Update architecture/state documentation**

Replace `installError`, `hostVersionMismatch`, and `needs-update` with:

- typed failure state/table;
- recovery state transitions;
- non-blocking version notice;
- capability-based feature gating;
- explicit-only future incompatibility;
- local diagnostic report schema and redaction.

Expected: `docs/DOCUMENTATION.md` matches the implementation and current file tree.

- [ ] **Step 3: Update privacy and security claims**

State that helper diagnostics are created only on click, remain local until the user copies/exports them, and exclude the data listed in this plan. Preserve the existing no-background-telemetry promise.

Document how users verify checksums, attestations, Apple signatures, and Windows Authenticode, and where to report a suspected false positive.

Expected: no documentation implies automatic diagnostic or antivirus submission.

- [ ] **Step 4: Update release documentation**

Document:

- selected Windows signing provider and expected signer subject;
- why all Windows layers are signed;
- fail-closed behavior;
- exact-candidate clearance;
- SmartScreen reputation versus actual detection;
- one-publisher continuity;
- protected publication approval;
- the full asset matrix.

Expected: a future maintainer can repeat the release without recovering unwritten decisions.

- [ ] **Step 5: Check stale references**

```bash
rg -n \
  "installError|hostVersionMismatch|needs-update|major\\.minor|Skipping Windows signing|optional.*Windows sign|linux-amd64 only|curl.*\\|.*sh" \
  README.md docs packaging packages scripts .github
```

Expected: no stale behavioral claim remains. Any test fixture match is intentional and explained.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md docs packaging/linux/README.md packaging/macos/README.md packaging/windows/README.md
git commit -m "Document reliable helper activation and releases"
```

Expected: one focused documentation commit exists inside the same pull request.

---

## Task 8: Run the cross-platform matrix and prepare the single coordinated pull request/release

Do not split this work into multiple pull requests. Keep the branch open until every blocking external gate has evidence.

**Files:**

- Verify: entire changed surface
- Update: pull-request checklist and release workflow summary only

- [ ] **Step 1: Run repository-wide static/unit validation**

```bash
pnpm install --frozen-lockfile
pnpm validate:ids
pnpm validate:release-tag "v$(node -p 'require("./packages/extension/package.json").version')"
pnpm typecheck
pnpm test
pnpm build
pnpm review:firefox
bash scripts/install.test.sh
(cd host && go test -race ./... && go vet ./...)
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/*.yml
git diff --check
```

Expected: every command passes. CI may run its existing `corepack enable` bootstrap; contributor-local validation must not mutate global shims as part of this checklist.

- [ ] **Step 2: Run browser E2E validation**

```bash
pnpm e2e:full:chrome
pnpm e2e:full:firefox
```

Expected: install failure taxonomy, retry recovery, non-blocking version notice, diagnostics controls, and normal proxy behavior pass in both browser families.

- [ ] **Step 3: Run platform packaging validation**

Linux:

```bash
make host-all
VERSION=v0.0.0 ./packaging/linux/build-packages.sh
```

macOS:

```bash
VERSION=0.0.0 ./packaging/macos/build-pkg.sh
pkgutil --payload-files dist/tailchrome-helper-macos.pkg
```

Windows, on a Windows runner:

```powershell
pwsh -NoProfile -File .\scripts\verify-windows-signatures.test.ps1
.\packaging\windows\build-msi.ps1 `
  -Version v0.0.0 `
  -HelperExe .\signed-windows\tailscale-browser-ext-windows-amd64.exe `
  -OutPath .\signed-windows\tailchrome-helper-windows-x64.unsigned.msi
```

The selected provider step must sign that outer unsigned MSI to `.\signed-windows\tailchrome-helper-windows-x64.msi`. Only then run:

```powershell
.\scripts\verify-windows-signatures.ps1 `
  -RawExe .\signed-windows\tailscale-browser-ext-windows-amd64.exe `
  -Msi .\signed-windows\tailchrome-helper-windows-x64.msi `
  -ExpectedSignerSubject $env:WINDOWS_EXPECTED_SIGNER_SUBJECT
```

Expected: all package formats contain the intended architecture/payload and pass their platform-specific verification.

- [ ] **Step 4: Run clean-machine smoke tests**

Matrix:

| Platform | Architecture | Required smoke coverage |
| --- | --- | --- |
| macOS | Intel | package install, automatic registration, repair app, extension connection, uninstall |
| macOS | Apple Silicon | same, plus correct raw repair selection |
| Debian/Ubuntu | amd64 | package install, Chrome/Chromium/Firefox discovery, repair after forced user-registration failure, uninstall |
| Debian/Ubuntu | arm64 | verified raw helper install/repair, extension discovery, and actual installed-path uninstall |
| Fedora/RHEL | x86_64 | RPM paths including `/usr/lib64` Firefox manifest, repair, uninstall |
| Fedora/RHEL | aarch64 | verified raw helper install/repair, extension discovery, and actual installed-path uninstall |
| Windows 11 | x64 standard user | signed MSI, embedded signed EXE, native-host discovery, repair, upgrade, uninstall, Defender/Malwarebytes behavior |

Expected: package-first setup succeeds where system paths apply and the user-scope repair recovers the intentionally broken discovery case.

- [ ] **Step 5: Audit locked-decision coverage**

Confirm:

- no WASM/helper replacement;
- no telemetry or automatic report submission;
- no updater/package-manager expansion;
- no browser-brand guessing;
- no Linux per-user package hook;
- macOS repair app restored;
- no semantic-version block;
- one selected Windows publisher;
- raw/embedded EXE and MSI signatures verified;
- exact candidate security evidence present;
- SmartScreen unknown reputation treated as non-blocking;
- all assets publish together.

Expected: every locked decision maps to code, tests, documentation, or a release gate.

- [ ] **Step 6: Review final branch scope**

```bash
git status --short --branch --untracked-files=all
git diff --stat origin/main...
git diff --check origin/main...
git log --oneline origin/main..HEAD
```

Expected: only the planned implementation is present, no credentials or identity documents are tracked, and the two macOS bundle files are restored rather than deleted.

- [ ] **Step 7: Open one pull request and keep it gated**

The pull request description must include:

- user-visible behavior;
- failure taxonomy;
- Linux artifact matrix;
- selected signer subject/provider;
- signature-verification workflow result;
- exact Defender/Malwarebytes candidate hashes and result status;
- manual platform matrix;
- explicit remaining blockers.

Expected: the pull request is not merged while any signing, signature, detection, or platform blocker remains.

- [ ] **Step 8: Run one coordinated release**

After merge, build one candidate from the release tag and record its candidate run ID/manifest digest. Clear that exact hash set, dispatch the protected publish workflow with those identifiers, and publish the same staged bytes together. Do not reuse a clean determination from the pull-request test build if the release build hashes differ. If the candidate expired, rebuild and repeat every clearance step.

Expected: one release contains the complete signed/verified artifact matrix and its checksums/attestations.

---

## Final Release Gate Checklist

- [ ] SignPath and Azure onboarding outcomes are recorded; one provider is selected.
- [ ] The production workflow contains exactly one Windows signing provider.
- [ ] The expected signer subject is documented and asserted in CI.
- [ ] The final raw Windows EXE has a valid timestamped signature.
- [ ] The MSI-embedded EXE has a valid timestamped signature and the same SHA-256 as the raw EXE.
- [ ] The outer MSI has a valid timestamped signature from the same expected publisher.
- [ ] No missing signing configuration can be skipped.
- [ ] Final checksums were generated after every signing/notarization/package step.
- [ ] Defender reports no malware, PUA, or behavioral detection for the exact final EXE/MSI hashes.
- [ ] Malwarebytes reports no malware, PUA, or behavioral detection for the exact final EXE/MSI hashes.
- [ ] Any previous detection has a final clean vendor determination and same-hash retest.
- [ ] A normal signed SmartScreen unknown-reputation warning, if present, is documented but not misreported as malware.
- [ ] macOS package contains a signed launchable `Tailchrome Helper.app`.
- [ ] Linux amd64 and arm64 raw helpers pass architecture and clean-machine tests; existing amd64/x86_64 DEB/RPM packages pass metadata tests.
- [ ] The fallback script requires a version, verifies its artifact, invokes `-install-now`, and prints the correct uninstall path.
- [ ] Packages remain primary and contain no per-user post-install side effects.
- [ ] Registration repair appears after discovery failure and does not guess browser brand.
- [ ] Version differences are non-blocking and features are capability-gated.
- [ ] Diagnostics are local, allowlisted, sanitized, copyable/exportable, and contain none of the excluded data.
- [ ] The complete release asset matrix is assembled before publication approval.
- [ ] Publication references the original candidate run ID and `SHA256SUMS.txt` digest; an expired candidate is rebuilt and fully retested.
- [ ] The bytes cleared by the reviewer are the bytes published.
- [ ] No release asset is replaced with `--clobber`, and the coordinated draft is explicitly published only after the checklist passes.

---

## Self-Review Notes

Before declaring implementation complete:

1. Trace each locked decision to at least one task, automated test, manual gate, or checklist item.
2. Confirm there is no placeholder such as “choose provider later” in production workflow code.
3. Confirm no UI message infers SmartScreen, antivirus, browser brand, or a manifest path from a generic disconnect.
4. Confirm failure classification happens once at the native-host boundary.
5. Confirm diagnostic serialization starts from an allowlist and does not serialize `TailscaleState` wholesale.
6. Confirm an older helper can connect and use its advertised features.
7. Confirm package install/uninstall ownership is symmetrical and user-scope repair remains explicit.
8. Confirm the release job cannot reach GitHub Release publication with unsigned, unscanned, missing, or hash-changed candidates.
9. Confirm public signing and privacy text is factually accurate for the provider actually selected.
10. Confirm the pull request remains one coherent change even though it uses focused internal commits.
