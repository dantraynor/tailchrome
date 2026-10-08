# SignPath Foundation test signing

SignPath Foundation accepted Tailchrome on October 8, 2026. The `tailchrome`
project has a `test-signing` policy using **Test certificate 2026**, and
**GitHub.com** is linked as a trusted build system. The `release-signing`
policy's production certificate is still pending. SignPath will review a
working test-signing setup before issuing that certificate.

The manual [SignPath Test Signing workflow](../.github/workflows/signpath-test.yml)
builds both Windows helpers, signs them with the test policy, builds the MSI
from the signed amd64 helper, and signs the outer MSI. It verifies the exact
test certificate, SHA-256 signatures, RFC 3161 timestamps, and a byte-identical
MSI payload using the existing Windows release verifier.

Its outputs are self-signed onboarding artifacts, not release candidates.
Keep `WINDOWS_ALLOW_UNSIGNED_RELEASE` and `WINDOWS_EXPECTED_SIGNER_SUBJECT`
separate from this setup; the test certificate must never become the expected
production signer.

## SignPath dashboard

Open the `tailchrome` project, which should list
`https://github.com/dantraynor/tailchrome.git` as its repository URL.

1. Under **Artifact Configurations**, add two custom XML configurations with
   these exact slugs:

   | Slug | XML to paste |
   | --- | --- |
   | `windows-executables` | [windows-executables.xml](../packaging/windows/signpath/windows-executables.xml) |
   | `windows-msi` | [windows-msi.xml](../packaging/windows/signpath/windows-msi.xml) |

   The initial single-PE configuration does not match GitHub's artifact ZIPs.
   The workflow explicitly selects the two configurations above, so neither
   needs to be the default.

2. Confirm **GitHub.com** is linked under **Trusted Build Systems** and its
   organization-level configuration permits this repository. In the
   `test-signing` policy, choose **Edit** and enable **Require trusted build
   system**; the project-level link alone does not enforce it. All jobs leading
   up to these requests use GitHub-hosted runners.
3. Confirm `test-signing` uses **Test certificate 2026** and RFC 3161
   timestamping. The initial test policy approves requests automatically; if
   approval is enabled later, the workflow waits for it. Grant the API token's
   user submitter access to this test policy. Scope that access to test signing
   for onboarding. Production signing still requires the explicit approvals
   in the code-signing policy.
4. Find the organization ID in SignPath's organization settings. Download the
   public test certificate and obtain its SHA-256 fingerprint independently of
   any returned signed artifact. For a DER-encoded `.cer` on macOS or Linux:

   ```bash
   openssl x509 -inform DER -in test-certificate.cer -noout -fingerprint -sha256
   ```

   For a PEM-encoded download, omit `-inform DER`. Use the hex fingerprint
   after `=`; colon separators are accepted. This is the certificate's SHA-256
   fingerprint, not its SHA-1 thumbprint and not a hash of the PEM text.

Do not enable signing of the MSI's nested EXE in the second configuration.
That EXE is already signed in the first request. Re-signing it would change its
bytes and fail the verifier's embedded/raw equality check.

## GitHub settings

In **Settings → Secrets and variables → Actions**, configure:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `SIGNPATH_ORGANIZATION_ID` | `3e3cbe9e-5a38-453b-8edd-a8c4596a5f3e` |
| Variable | `SIGNPATH_TEST_CERTIFICATE_SHA256` | The downloaded test certificate's SHA-256 fingerprint |
| Secret | `SIGNPATH_API_TOKEN` | A SignPath API token authorized to submit to `tailchrome` / `test-signing` |

The project slug (`tailchrome`), policy (`test-signing`), and artifact
configuration slugs are fixed in the workflow. There is no production-policy
input. Neither organization ID nor certificate fingerprint is a secret.

The API token can also be stored with an interactive prompt:

```bash
gh secret set SIGNPATH_API_TOKEN --repo dantraynor/tailchrome
```

Keep the token in GitHub Secrets. No private certificate or signing key is
needed in GitHub: SignPath holds the signing key.

## Run and review

After the workflow is merged into the default branch:

1. Open **Actions → SignPath Test Signing → Run workflow** and select the
   reviewed branch or tag. The workflow builds that revision and uses it for
   MSI packaging and verification as well. It has no local-artifact input.
2. The EXE request uses the policy's automatic approval. If approvals have
   been enabled, review the source revision and approve it in SignPath. The
   workflow waits up to 30 minutes for each request.
3. When the signed EXEs return, the workflow checks the amd64 signer's
   fingerprint before temporarily trusting its self-signed certificate in the
   disposable Windows runner's current-user root store. It builds the MSI
   with the usual signature checks enabled, then submits the second request.
4. The outer-MSI request follows the same approval settings. The workflow
   verifies all final signatures and certificate fingerprints, checks the
   embedded EXE, and uploads `signpath-test-verified`. The run summary lists both signing request IDs;
   the artifact contains the signed files, verification hashes, source SHA,
   run URL, and signing request IDs. Artifacts expire after seven days.
5. Provide SignPath with the successful run URL and both signing request IDs
   for their setup review. Download the evidence if review will take longer
   than the artifact retention period.

The unsigned submission ZIPs are also retained as
`signpath-test-unsigned-executables` and `signpath-test-unsigned-msi`. GitHub's
upload action creates each ZIP with the files at its root; do not wrap the
files in another ZIP or include a `dist/` directory in the artifact XML paths.

Test helpers identify themselves as `v0.0.0-signpath-test.<run-id>.<attempt>`;
the MSI uses version `0.0.0`. The workflow removes temporary certificate trust
even if subsequent steps fail. Do not install that trust certificate on user
machines or distribute these files as signed production releases.

## Production handoff

After SignPath reviews the test run and imports the production certificate,
record its exact publisher subject in
[WINDOWS_CODE_SIGNING_POLICY.md](WINDOWS_CODE_SIGNING_POLICY.md). A separate
reviewed change must wire `release-signing` into the release candidate
workflow, verify the production certificate through normal Windows trust,
configure `WINDOWS_EXPECTED_SIGNER_SUBJECT`, and remove
`WINDOWS_ALLOW_UNSIGNED_RELEASE`. The existing Defender, Malwarebytes, native
ARM64, and protected publication gates still apply.

The test workflow does not publish releases or satisfy those production gates.

## References

- [SignPath GitHub trusted-build integration](https://about.signpath.io/documentation/trusted-build-systems/github)
- [SignPath artifact configuration](https://about.signpath.io/documentation/artifact-configuration/)
- [Artifact configuration examples](https://about.signpath.io/documentation/artifact-configuration/examples)
