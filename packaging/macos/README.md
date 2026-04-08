# macOS Helper installer (.pkg)

The script `build-pkg.sh` produces `dist/tailchrome-helper-macos.pkg`, which installs:

1. **Universal** `tailscale-browser-ext` at  
   `/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext`
2. **Tailchrome Helper** in `/Applications` — a small app the user opens once; it runs  
   `tailscale-browser-ext -install-now` to register Chrome/Firefox native messaging for the **current user** (no Terminal).

## Unsigned builds

CI and local runs produce an unsigned package. Gatekeeper may require **right-click → Open** the first time, or **System Settings → Privacy & Security**.

## Signing and notarization (release quality)

Requirements: Apple Developer Program, **Developer ID Application** and **Developer ID Installer** certificates installed in the Keychain (or provided to CI via a `.p12` export — prefer a dedicated CI keychain on a runner you control).

1. Set identities (exact names from `security find-identity -p basic -v`):

   ```bash
   export MACOS_SIGN_APPLICATION_IDENTITY="Developer ID Application: Your Team (TEAMID)"
   export MACOS_SIGN_INSTALLER_IDENTITY="Developer ID Installer: Your Team (TEAMID)"
   ```

2. Build:

   ```bash
   ./packaging/macos/build-pkg.sh
   ```

3. Notarize the **installer .pkg** (not the app alone):

   ```bash
   xcrun notarytool submit dist/tailchrome-helper-macos.pkg \
     --apple-id "$APPLE_ID" \
     --team-id "$APPLE_TEAM_ID" \
     --password "$APPLE_APP_SPECIFIC_PASSWORD" \
     --wait
   xcrun stapler staple dist/tailchrome-helper-macos.pkg
   ```

Store Apple credentials in GitHub Actions secrets for automated release; do not commit them.

## GitHub Actions

The release workflow runs `build-pkg.sh` on `macos-latest` and uploads the `.pkg` to the GitHub Release. Add repository secrets and wire optional signing/notarization steps when you are ready.
