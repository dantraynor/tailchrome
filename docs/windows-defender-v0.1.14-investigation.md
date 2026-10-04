# Windows Defender investigation: v0.1.14

The Defender block reported in
[issue #133](https://github.com/dantraynor/tailchrome/issues/133) was not
reproduced with the exact published v0.1.14 Windows x64 helper. Retained
Windows 11 evidence from September 26, 2026 shows a clean scan and successful
standard-user installation, execution, repeated installation/repair, direct
native messaging, and uninstall. A fresh Windows Server test on October 3
also passed with newer definitions, including real Chrome native messaging.
The investigation of the reported installer failure is complete; these
results do not establish Microsoft vendor clearance or approve a new release.

## Original artifact and scans

The tested file was `tailscale-browser-ext-windows-amd64.exe` from `v0.1.14`,
SHA-256:

```text
5c7cec543d8a4dabcfbc6cb8addbf3b7a836aa623ae9826c651b460805ae1adf
```

It matched the published
[release checksum manifest](https://github.com/dantraynor/tailchrome/releases/download/v0.1.14/SHA256SUMS.txt)
and was not rebuilt or resigned. Both scans recorded matching expected,
pre-scan, and post-scan hashes.

| Recorded value | Windows 11 | Windows Server |
| --- | --- | --- |
| Edition and build | Enterprise Evaluation x64, build `26200` | Server 2025 Datacenter x64, build `26100` |
| Environment | x64 guest emulated by UTM on Apple Silicon | Azure x64 VM |
| Scan interval, UTC | September 26, `07:41:00–07:41:24` | October 3, `06:10:46–06:10:59` |
| Defender platform | `4.18.26080.4` | `4.18.26080.4` |
| Defender engine | `1.1.26080.3` | `1.1.26080.3` |
| Security intelligence | `1.459.408.0` | `1.459.528.0` |
| Definitions updated, UTC | September 26, `00:59:37` | October 2, `22:18:00` |
| File-scan exit code | `0` | `0` |
| Collector result | `no-detection-observed` | `no-detection-observed` |
| Artifact-related threat records | None; history query succeeded | None; history query succeeded |
| Quarantine or file change | None observed | None observed |

Both environments passed readiness checks with active Defender, real-time,
behavior, downloaded-file, network inspection, PUA, and cloud protection.
Cloud connectivity and the harmless detection smoke test passed, and the
artifact was not excluded from scanning. The collectors checked the final
hash and threat history after waiting for delayed cloud verdicts. The dates
above are the actual test dates; the Windows 11 records were recovered on
October 3, not rerun that day.

## Lifecycle coverage

Both environments used the original published PowerShell installer, pinned
to SHA-256
`ce335e2ca815b49cd6be2c5531d8d2b14ddd6b1e92776328823ea39b93b1a323`,
with explicit `-AllowUnsigned`. This permits the unsigned release while
leaving Defender protection enabled. Installed helper hashes matched the
original EXE.

| Check | Windows 11, September 26 | Server 2025, October 3 |
| --- | --- | --- |
| User context | Non-elevated interactive standard-user session | Temporary non-admin accounts with loaded profiles |
| Original installer and helper version execution | Passed; `v0.1.14` | Passed; `v0.1.14` |
| PowerShell repair | Repeated installation passed | Removed Chrome registration restored; native ping repeated |
| Direct native messaging | Startup, initialization, status, ping, and clean exit passed | Framed startup and ping passed |
| Loopback proxy without credentials | Rejected with HTTP `407` | Not separately tested |
| PowerShell uninstall | Passed; helper executable removed | Passed; owned EXE, registrations, manifests, and receipts removed |
| Real Chrome native messaging | Not tested | Passed; headless Chrome for Testing `154.0.8037.92` |
| MSI install, repair, native smoke, uninstall | Passed separately with the same helper hash | Not tested |
| Defender after lifecycle | Active protection; no new runtime detections | Active protection; no new detections |

The Windows 11 lifecycle ran `07:52:55–07:58:28 UTC`, including its separate
MSI checks. Its direct protocol test launched the helper with framed standard
input/output, observed `procRunning`, initialized the embedded node, received
status and `pong`, and confirmed exit code `0`. The MSI file tested had SHA-256
`29c89d29d991f4493087a2d8260298927fa9b64433a5627df920c0a3f39c3429`.
These records establish actual helper execution, rather than a file scan alone.
They do not claim browser-launched execution on Windows 11.

The Server browser test loaded the published `v0.1.14` extension archive,
SHA-256 `f04127e970feac41feed91140ae9cd7629b22bedbc6dfa485cbb0a7ab5f395bb`,
verified against the release manifest. From the extension's context,
`chrome.runtime.connectNative` launched the registered helper and received
`procRunning` with version `v0.1.14` and `pong`. The direct lifecycle completed
at `06:11:39 UTC` and the browser lifecycle at `06:12:26 UTC`. Both reports
confirmed active Defender, successful threat-history queries, no new detections,
and removal of temporary tasks, accounts, and batch-logon rights without errors.

On Server, all six fixture suites returned exit code `0`: installer `19/19`,
initializer `11/11`, and collector `16/16` in each of PowerShell 5.1 and 7,
for 92 passing cases. Those fixture sources were pinned to commit
`5d343043b71e5a6df60153789e9236af964f6869`. Retained Windows 11 records also
show successful initializer/collector fixtures under PowerShell 5.1; they do
not establish the same six-suite matrix on Windows 11.

## Evidence, cleanup, and limits

The Windows 11 reports and test scripts were retained in the Mac's validation
setup folder and exported read-only on October 3. Their original September 26
timestamps were preserved. The recovered scripts confirm the installer/hash
checks, non-elevated interactive session, direct protocol assertions, and
Defender history collection; all 15 report files matched the verified export.
The retained script archive redacts a historical VM login password; the
original setup files remain unchanged on the Mac.

| Retained evidence archive | SHA-256 |
| --- | --- |
| Windows 11 reports, 15 files | `4dd2c08f1d52862ef246afe1631aca33ff6545de14059d5f32b3d093c2461ac9` |
| Windows 11 test scripts, 5 files, login password redacted | `5c47cc0736b7ba3352df01eb983fdd66734f0a13f0872acfdd1aad6f521626c5` |
| Server reports and logs, 57 files | `09904f3cfe81a1ec2fea14402216c07360e9f018931286dd598a673b77e5c986` |

The Server evidence export excluded browser profiles, console output, and
proxy credentials. Both disposable Azure groups were independently confirmed
absent at `06:18:29 UTC` on October 3; the source snapshot was preserved.
A subsequent disposable Windows 11 attempt stopped after its guest agent
failed to become ready, with its source VM preserved. That attempt ran no new
scan or lifecycle test and does not alter the retained September 26 results.

Real Chrome integration on Windows 11, SmartScreen publisher reputation,
authenticated tailnet connectivity, existing node-state preservation, and
native ARM64 execution remain untested. These are separate coverage limits,
not additional requirements to establish whether Defender blocked the
reported installer execution. UTM x64 emulation does not establish native
ARM64 or native x64 hardware coverage.

No Microsoft submission or analyst determination is recorded. The findings
are “not reproduced with the recorded definitions,” without a confirmed
false-positive or vendor-clearance claim. The
[investigation and release procedure](windows-defender-validation.md) still
applies to final release artifacts.
