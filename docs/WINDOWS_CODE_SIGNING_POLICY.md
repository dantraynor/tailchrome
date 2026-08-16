# Windows Code Signing Policy

This policy covers the Windows helper executable and MSI published from
<https://github.com/dantraynor/tailchrome>.

## Current release gate

Signed Windows publication is blocked until one signing provider has accepted
the project, issued one stable publisher identity, and produced a successfully
timestamped test signature. The repository currently has no selected Windows
provider or approved Authenticode signer subject. A release must not substitute
a locally generated certificate or a second provider when signing is
unavailable.

While provider onboarding is pending, the maintainer may explicitly ship
unsigned Windows binaries by setting the `WINDOWS_ALLOW_UNSIGNED_RELEASE`
repository variable to `true`. Unsigned mode is mutually exclusive with a
configured signer subject, skips Defender clearance evidence, records
`windowsSigning: unsigned` in the candidate metadata, and still requires the
protected publication approval. Users installing these builds see the ordinary
SmartScreen unknown-publisher warning. The variable must be removed as soon as
a signing provider and expected signer subject are recorded, at which point the
fail-closed signed gate below is the only release path again.

SignPath Foundation and Azure Artifact Signing Individual are the evaluated
onboarding paths. SignPath is preferred if the Foundation application is
accepted and its trusted-build flow succeeds. Otherwise, Azure may be selected
after Individual identity validation and a successful OIDC-backed test
signature. Exactly one integration and one expected signer subject must be
recorded here before this change can merge.

If SignPath supplies the production signature, the project home and download
surfaces must include this acknowledgement:

> Free code signing provided by SignPath.io, certificate by SignPath Foundation

The acknowledgement must be removed or revised if SignPath is not the service
providing the published signatures.

## Public project and artifacts

- Project home: <https://tesseras.org/tailchrome>
- Source: <https://github.com/dantraynor/tailchrome>
- Release artifacts: <https://github.com/dantraynor/tailchrome/releases>
- Privacy policy: [privacy-policy.md](privacy-policy.md)
- Security policy and reporting: [SECURITY.md](SECURITY.md)

The signed Windows release consists of:

- `tailscale-browser-ext-windows-amd64.exe`;
- the same signed executable embedded as `tailscale-browser-ext.exe` inside
  `tailchrome-helper-windows-x64.msi`; and
- the signed outer `tailchrome-helper-windows-x64.msi`.

## Roles

- **Maintainer:** approves policy changes, provider selection, publisher
  migrations, and releases.
- **Developer:** prepares reviewed source changes but cannot approve their own
  release solely by authoring them.
- **Signing submitter:** submits only artifacts produced by the reviewed,
  GitHub-hosted release workflow.
- **Signing approver:** reviews the source revision and signing request before
  the provider releases a signature.
- **Release reviewer:** compares Defender and Malwarebytes results with the
  exact candidate hashes and approves the protected publication environment.

One person may hold more than one role for a small project, but the workflow's
provider approval and protected publication approval must remain explicit.

## Eligible build source

Only a tagged commit in this public repository built by the checked-in GitHub
Actions workflow on GitHub-hosted runners is eligible for production signing.
Local binaries, fork workflow runs, pull-request artifacts, rebuilt candidates,
and artifacts modified after the candidate manifest was generated are not
eligible for publication.

The signing order is fixed:

1. Build the raw Windows helper from the tagged source.
2. Sign and timestamp the raw EXE.
3. Verify the EXE's subject, chain, digest, timestamp, and SHA-256.
4. Build the MSI from that exact signed EXE.
5. Sign and timestamp the outer MSI with the same publisher identity.
6. Extract the MSI without executing it and prove the embedded EXE is
   byte-identical to the signed raw EXE.
7. Verify both final files again before candidate assembly and publication.

Signing configuration is mandatory. A missing credential, OIDC permission,
provider approval, expected subject, timestamp, or verification tool fails the
whole Windows release path.

## Provider authentication and secrets

The selected integration must use the provider's supported GitHub trusted-build
or OIDC flow. No private signing key, certificate file, identity document,
billing detail, or long-lived provider credential may be committed to the
repository or included in a workflow artifact.

Repository secrets and environment protection rules may contain only the
minimum configuration required by the selected provider. Identity and billing
documents stay in the provider account. Production signing configuration must
not expose a workflow input that switches providers or publisher identities.

## Signature and timestamp requirements

All three Windows signature surfaces—the raw EXE, the MSI-embedded EXE, and the
outer MSI—must:

- report a valid Authenticode status;
- chain to the one expected signer subject recorded in this policy;
- use SHA-256 file digesting;
- contain a valid RFC 3161 timestamp proving the certificate was valid when the
  artifact was signed; and
- pass the pinned Windows SDK `signtool verify /pa /all /v` check.

`Get-AuthenticodeSignature` supplies an additional structured assertion; it
does not replace SignTool chain, digest, and timestamp verification.

Checksums are generated only after signing, MSI construction, notarization of
other platform artifacts, and final package staging. The exact signed Windows
hashes in that manifest are the hashes reviewed for security clearance.

## Security clearance

A clean signature does not establish that runtime behavior is safe. Before
publication, the exact final EXE and MSI must pass current Defender and
Malwarebytes file and behavioral checks in the controlled Windows validation
environment. A malware, PUA, or behavioral detection blocks publication until
the vendor returns a clean determination and the same hash passes again with
current definitions.

A validly signed SmartScreen unknown-reputation prompt is documented for users
but is not itself a malware detection. An invalid signature or an actual
SmartScreen/Defender classification remains blocking.

The complete procedure is in [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).

## Compromise, revocation, and publisher migration

Anyone who suspects signing-account compromise, unauthorized submission,
credential exposure, or a misissued signature must stop publication and report
it through [SECURITY.md](SECURITY.md). The maintainer must:

1. disable the affected provider project, workflow credential, or OIDC trust;
2. preserve the relevant run IDs, hashes, signing logs, and timestamps;
3. request certificate revocation or provider incident response as applicable;
4. identify every release signed by the affected identity;
5. publish a security notice and replacement artifacts only after a new review
   and exact-candidate clearance; and
6. rotate repository credentials and environment approvals before re-enabling
   signing.

Changing provider or signer subject is a publisher migration, not an automatic
fallback. It requires a separately reviewed policy and workflow change,
documented user notice, a fresh test signature, and a new security-clearance
cycle. The release workflow must never alternate identities silently.
