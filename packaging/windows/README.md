# Windows Helper installer (.msi)

`build-msi.ps1` produces `dist/tailchrome-helper-windows-x64.msi`.

The MSI is per-user. It installs a staged helper executable at:

```text
%LOCALAPPDATA%\Tailscale\BrowserExt\installer\tailscale-browser-ext.exe
```

After files are installed, the MSI runs that staged executable with `-install-now`. The Go installer then copies the browser-launched helper to `%LOCALAPPDATA%\Tailscale\BrowserExt\tailscale-browser-ext.exe` and writes HKCU native messaging registrations for supported Chromium-family browsers and Firefox.

On uninstall, the MSI runs the staged executable with `-uninstall` to remove those manifests, HKCU registrations, and normally the runtime executable. If a browser still has a runtime or moved-aside update executable open, the file may remain on disk but is inert once deregistered. Before uninstall, the new helper retries moved-aside sidecar cleanup on each launch after the old process exits; no administrator-only reboot cleanup is required. Major upgrades skip deregistration; the new version rewrites the registrations instead.

## Build

Install WiX first:

```powershell
dotnet tool install --global wix --version 6.0.2
```

Then build from the repository root:

```powershell
.\packaging\windows\build-msi.ps1 -Version v0.1.12
```

The release workflow may sign the MSI when Windows signing secrets are configured. Unsigned local builds still work for manual testing.
