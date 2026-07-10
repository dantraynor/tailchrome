# Windows Helper installer (.msi)

`build-msi.ps1` produces `dist/tailchrome-helper-windows-x64.msi`.

The MSI is per-user. It installs a staged helper executable at:

```text
%LOCALAPPDATA%\Tailscale\BrowserExt\installer\tailscale-browser-ext.exe
```

After files are installed, the MSI runs that staged executable with `-install-now`. The Go installer then copies the browser-launched helper to `%LOCALAPPDATA%\Tailscale\BrowserExt\tailscale-browser-ext.exe` and writes HKCU native messaging registrations for supported Chromium-family browsers and Firefox.

On uninstall, the MSI runs the staged executable with `-uninstall` to remove those manifests and HKCU registrations. The runtime copy of the exe stays on disk (a browser may still be running it) but is inert once deregistered. Major upgrades skip this step; the new version rewrites the registrations instead.

## Build

Install WiX first:

```powershell
dotnet tool install --global wix --version 6.0.2
```

Then build from the repository root:

```powershell
.\packaging\windows\build-msi.ps1 -Version v0.1.11
```

The release workflow may sign the MSI when Windows signing secrets are configured. Unsigned local builds still work for manual testing.
