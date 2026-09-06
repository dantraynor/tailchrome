class Tailchrome < Formula
  desc "Native helper for accessing a Tailscale network from your browser"
  homepage "https://github.com/dantraynor/tailchrome"
  version "0.1.13"
  license "MIT"

  depends_on :linux

  if on_arch_conditional(arm: true, intel: false)
    url "https://github.com/dantraynor/tailchrome/releases/download/v#{version}/tailscale-browser-ext-linux-arm64",
        using: :nounzip
    sha256 "4f54db1343a4de8d659907bab62abdb2a53d78d437a53db12803d7cd26c1a9af"
  else
    url "https://github.com/dantraynor/tailchrome/releases/download/v#{version}/tailscale-browser-ext-linux-amd64",
        using: :nounzip
    sha256 "2cd1e869d80a9c27f49e7d6959883b586e84d25859541693b7e33b467bb66213"
  end

  def install
    arch = Hardware::CPU.arm? ? "arm64" : "amd64"
    bin.install "tailscale-browser-ext-linux-#{arch}" => "tailscale-browser-ext"
  end

  def caveats
    <<~EOS
      Install the Tailchrome browser extension from the Chrome Web Store or Firefox Add-ons.

      After installing AND after each brew upgrade, disconnect Tailchrome, close
      your browsers, and register the helper for your user (without sudo):
        #{opt_bin}/tailscale-browser-ext -install-now
      This refreshes a separate runtime copy in ~/.local/share/tailscale/browser-ext.
      Reopen your browser when registration finishes.

      Before brew uninstall, remove that runtime copy and your browser registrations:
        #{opt_bin}/tailscale-browser-ext -uninstall
      Run this in each account that registered the helper.
      Tailscale identities and profile data are preserved.
    EOS
  end

  test do
    assert_equal "v#{version}", shell_output("#{bin}/tailscale-browser-ext -version").strip
    system bin/"tailscale-browser-ext", "-install-now"

    runtime = testpath/".local/share/tailscale/browser-ext/tailscale-browser-ext"
    chrome = testpath/".config/google-chrome/NativeMessagingHosts/com.tailscale.browserext.chrome.json"
    firefox = testpath/".mozilla/native-messaging-hosts/com.tailscale.browserext.firefox.json"
    assert_path_exists runtime
    assert_equal runtime.to_s, JSON.parse(chrome.read).fetch("path")
    assert_equal ["chrome-extension://bhfeceecialgilpedkoflminjgcjljll/"],
                 JSON.parse(chrome.read).fetch("allowed_origins")
    assert_equal runtime.to_s, JSON.parse(firefox.read).fetch("path")
    assert_equal ["tailchrome@tesseras.org"], JSON.parse(firefox.read).fetch("allowed_extensions")

    system bin/"tailscale-browser-ext", "-uninstall"
    refute_path_exists runtime
    refute_path_exists chrome
    refute_path_exists firefox
    assert_path_exists bin/"tailscale-browser-ext"
  end
end
