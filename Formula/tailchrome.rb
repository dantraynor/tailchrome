class Tailchrome < Formula
  desc "Browser native messaging host for Tailscale networks"
  homepage "https://github.com/dantraynor/tailchrome"
  url "https://github.com/dantraynor/tailchrome/archive/refs/tags/v0.1.13.tar.gz"
  sha256 "6f8da65c49a6f1a94c91dda5bf781db83ba4b9aaee7299cccd4aca0899750e57"
  license "MIT"

  depends_on "go" => :build

  def install
    ENV["CGO_ENABLED"] = "0"
    cd "host" do
      ts_version = Utils.safe_popen_read("go", "list", "-m", "-f", "{{.Version}}", "tailscale.com")
      ts_version = ts_version.strip.delete_prefix("v")
      ldflags = %W[
        -X main.version=v#{version}
        -X tailscale.com/version.shortStamp=#{ts_version}
        -X tailscale.com/version.longStamp=#{ts_version}
      ]
      system "go", "build", *std_go_args(ldflags:, output: bin/"tailscale-browser-ext")
    end
  end

  def caveats
    <<~EOS
      Install the Tailchrome browser extension from the Chrome Web Store or Firefox Add-ons.

      After installing AND after each brew upgrade, disconnect Tailchrome, close
      your browsers, and register the helper for your user (without sudo):
        #{opt_bin}/tailscale-browser-ext -install-now
      This refreshes a separate runtime copy in your user account.
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

    if OS.mac?
      support = testpath/"Library/Application Support"
      runtime = support/"Tailscale/BrowserExt/tailscale-browser-ext"
      chrome = support/"Google/Chrome/NativeMessagingHosts/com.tailscale.browserext.chrome.json"
      firefox = support/"Mozilla/NativeMessagingHosts/com.tailscale.browserext.firefox.json"
    else
      runtime = testpath/".local/share/tailscale/browser-ext/tailscale-browser-ext"
      chrome = testpath/".config/google-chrome/NativeMessagingHosts/com.tailscale.browserext.chrome.json"
      firefox = testpath/".mozilla/native-messaging-hosts/com.tailscale.browserext.firefox.json"
    end
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
