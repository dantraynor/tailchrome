cask "tailchrome" do
  version "0.1.13"
  sha256 "46719646d0c144d1ed3ea95fcbfca4ccd81296781519832d56ed26e810b6e045"

  url "https://github.com/dantraynor/tailchrome/releases/download/v#{version}/tailchrome-helper-macos.pkg"
  name "Tailchrome Helper"
  desc "Native helper for accessing a Tailscale network from your browser"
  homepage "https://github.com/dantraynor/tailchrome"

  depends_on :macos

  pkg "tailchrome-helper-macos.pkg"

  uninstall script:  {
              executable:   "/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext",
              args:         ["-uninstall"],
              sudo:         false,
              must_succeed: false,
            },
            pkgutil: "org.tesseras.tailchrome.helper"

  caveats <<~EOS
    Install the Tailchrome browser extension from the Chrome Web Store or Firefox Add-ons.
    Restart your browser after installing or upgrading the helper.

    To register another macOS user or repair browser discovery, open:
      /Applications/Tailchrome Helper.app

    Before uninstalling, disconnect Tailchrome and close your browsers.
    Uninstall removes registrations for the current user. Other users should run
    the following command in their account before the package is removed:
      "/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext" -uninstall
    Tailscale identities and profile data are preserved.
  EOS
end
