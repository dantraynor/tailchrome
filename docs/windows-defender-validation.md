# Windows Defender investigation and release validation

Use this procedure for an antivirus detection such as [#133](https://github.com/dantraynor/tailchrome/issues/133).
Microsoft can review a suspected false positive before SignPath onboarding
finishes. An antivirus determination and SmartScreen publisher reputation are
separate: an unsigned file can pass a malware scan and still show an unknown
publisher warning. See [Microsoft's submission portal](https://www.microsoft.com/en-us/wdsi/filesubmission)
and [SmartScreen guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

## Free Windows 11 evaluation VM

For a local Windows 11 retest, use Microsoft's official
[90-day Windows 11 Enterprise evaluation](https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise).
The evaluation does not require a product key. Verify the ISO against the
SHA-256 published by Microsoft, and use a new VM with TPM 2.0 and Secure Boot.
Keep its disk separate from personal files and leave shared folders and
clipboard sharing disabled. Do not use activation utilities in the validation
image.

[UTM](https://docs.getutm.app/guides/windows/) is a free option on macOS. Match
the VM architecture to the ISO actually downloaded: the evaluation landing
page may advertise an architecture that its download page does not yet offer.
An x64 ISO requires emulation on Apple Silicon and can be substantially slower
than a native VM. Record that distinction in the evidence; x64 emulation does
not provide native ARM64 coverage or prove hardware-specific compatibility.
An ordinary retail ARM64 ISO is not the Enterprise evaluation.

After setup, record the Windows build, evaluation activation state, Secure
Boot/TPM status, and current Defender platform and definition versions. Follow
the evidence procedure below, then test install, repair, helper execution, and
uninstall from an interactive standard-user desktop. Preserve any SmartScreen
warning separately from antivirus detections. Test the exact published version
and the final new-release artifacts separately. Shut down the VM when finished;
the local evaluation does not require an Azure Windows client entitlement.

## Disposable Azure investigation VM

Create a dedicated resource group and a Windows Server 2025 Datacenter Gen2
**x64** VM. Choose an available 2-vCPU, 8-GiB size, such as `Standard_D2s_v5`
or `Standard_D2as_v7`, a Standard SSD OS
disk, and the default Windows license included in the image. Confirm regional
availability and the portal's price before creating it. Use an isolated virtual
network without peering to private networks, and no managed identity or signing
credentials. No inbound ports are needed when using Azure **Run command →
RunPowerShellScript**. Enable auto-shutdown; after preserving evidence, delete
the dedicated resource group, including its disks and network resources.

Defender Antivirus is available on Windows Server. This VM can investigate
file detections and host the release's controlled x64 scan. It does **not**
replace the release checklist's clean Windows 11 lifecycle tests or native
ARM64 tests. Windows client images in Azure have separate license eligibility;
Azure credits alone do not establish that eligibility.

- [Azure Windows VM setup](https://learn.microsoft.com/en-us/azure/virtual-machines/windows/quick-create-portal)
- [Defender on Windows Server](https://learn.microsoft.com/en-us/defender-endpoint/microsoft-defender-antivirus-on-windows-server)
- [Windows client image eligibility](https://learn.microsoft.com/en-us/azure/virtual-machines/windows/client-images)

## Capture the reported file's evidence

1. Copy the reviewed `scripts/initialize-windows-defender.ps1` and
   `scripts/collect-windows-defender-evidence.ps1` to the disposable VM. From an
   elevated **PowerShell 7** session, run the initializer with `-RunDetectionSmokeTest` and a
   `-SummaryPath`. It enables the validation settings, removes exclusions,
   updates definitions, and verifies detection using the standard harmless
   test file. Use it only on a dedicated validation machine.
   Azure Run Command starts in Windows PowerShell 5.1; invoke the installed
   `C:\Program Files\PowerShell\7\pwsh.exe` explicitly for initialization.
   A successful update command alone is insufficient: the initializer verifies
   signature freshness and tries Microsoft's MMPC source if Windows Update
   returns without refreshing stale definitions.
2. Download the exact published artifact and `SHA256SUMS.txt` from the same
   pinned release. Keep a verified original outside the VM for submission;
   Defender may quarantine its local copy. Record the release tag and expected
   hash before transfer. Do not rebuild a reported binary.
3. Run the diagnostic collector for each target, supplying a new evidence path:

```powershell
.\collect-windows-defender-evidence.ps1 `
  -ArtifactPath .\tailscale-browser-ext-windows-amd64.exe `
  -ExpectedSha256 5c7cec543d8a4dabcfbc6cb8addbf3b7a836aa623ae9826c651b460805ae1adf `
  -ReleaseTag v0.1.14 `
  -EvidencePath .\evidence\v0.1.14-amd64-first-scan.json
```

The hash above identifies the **published v0.1.14 x64 helper only**. Derive the
hash independently from the matching manifest for every other file or release.

The collector updates definitions, verifies the hash, checks cloud connectivity
and exclusions, and scans without executing the helper or changing protection
preferences. After a successful scan command, it waits ten seconds for delayed
cloud verdicts before rechecking the file hash and reading detection history,
matching the release workflow. Its JSON records the definition version/time, scan output,
expected/observed hashes, and candidate-related threat names and IDs. It saves
an incomplete or detection report even if the file was already quarantined or
the scan failed, and returns an error for those outcomes. Historical detections
also prevent a passing result: use a fresh VM for the same-file retest instead
of deleting history. Do not disable Defender or restore quarantined files to
force a test through.

`no-detection-observed` describes only this diagnostic file scan. The report
always records `releaseClearance: false`; it cannot substitute for the release
workflow's evidence. If current definitions no longer reproduce the report,
record that result without claiming Microsoft reviewed or resolved the old
detection. Installation behavior still needs testing.

## Request Microsoft's review

If the detection persists and is believed to be incorrect, submit the exact
detected EXE at the Microsoft portal as **Software developer**. Select the
Defender product used to reproduce the detection and the appropriate
**Incorrectly detected as malware/malicious** or **Incorrectly detected as PUA**
category. Submit the affected executable first; include an MSI separately only
if it is itself detected.

Include the SHA-256, exact threat name, definition version, release URL, source
repository, issue URL, and installation reproduction. Describe Tailchrome's
native browser messaging, embedded Tailscale node, and authenticated loopback
proxy. Report the suspicion honestly; do not claim a confirmed false positive
or vendor clearance. The Microsoft account holder completes any sign-in or
human verification, then records the submission ID and analyst determination.

After a favorable determination, update definitions on a fresh VM and retest
the same hash. Preserve both reports and the submission reference. A new build,
including a newly signed build, requires separate validation.

## Connect the protected release runner

Keep the v0.1.14 investigation VM separate from the clean image used for new
release candidates. Follow the [release checklist](RELEASE_CHECKLIST.md):

1. Prepare a clean x64 image with current Windows/Defender, PowerShell 7, Git,
   and the GitHub Actions runner. Verify the Defender initializer and capture
   an immutable Azure image version or snapshot before exposing it to candidate
   files. Retain the readiness evidence with the image record.
2. Record that approved image's actual identifier in the **environment-scoped**
   `WINDOWS_DEFENDER_IMAGE_ID` under `windows-defender-validation`. The VM must
   carry the same host-owned machine variable `TAILCHROME_DEFENDER_IMAGE_ID`.
   Do not use a fabricated image label or a repository-scoped variable.
3. Create one fresh VM from that image per tagged Release Candidate run. Its
   host-owned pre-job hook must reject any repository, workflow, job, run ID,
   tag, source SHA, or image ID other than the approved values. Forward runner
   diagnostic logs to storage outside the VM.
4. After the protected deployment is reviewed, register only to this repository
   with `--ephemeral` and labels `self-hosted,Windows,X64,tailchrome-defender-<run-id>`.
   Run elevated for the `scan-windows-defender` job, then destroy the VM. Do not
   put the registration token into a snapshot, source file, or evidence report.

For the next release, scan the final x64 EXE, ARM64 EXE, and x64 MSI produced by
that candidate run. Complete the separate Windows 11 and native ARM64 lifecycle
checks and Malwarebytes review. Publish only the approved bytes through the
existing protected publication workflow. An unsigned release remains possible;
the Defender gate applies to both signing modes.
