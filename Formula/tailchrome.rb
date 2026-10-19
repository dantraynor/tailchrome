class Tailchrome < Formula
  desc "Browser native messaging host for Tailscale networks"
  homepage "https://github.com/dantraynor/tailchrome"
  url "https://github.com/dantraynor/tailchrome/archive/refs/tags/v0.1.15.tar.gz"
  sha256 "a9e242f0059c6f5756e628ff5f219220f57d2e585a0ef4d7b70e490701aa284c"
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
      system "go", "build", "-trimpath", *std_go_args(ldflags:, output: bin/"tailscale-browser-ext")
    end
    bin.install_symlink "tailscale-browser-ext" => "tailchrome"
  end

  def caveats
    helper = opt_bin/"tailscale-browser-ext"
    supports_install_command = false
    if File.executable?(helper.to_s)
      begin
        supports_install_command = Utils.safe_popen_read(helper.to_s, "--help", err: :out).include?("--binary-path")
      rescue
        # A pinned legacy helper may reject the new help form; retain its flags.
        supports_install_command = false
      end
    end
    install_command = if supports_install_command
      "#{helper} install --binary-path #{helper}"
    else
      "#{helper} -install-now"
    end
    uninstall_command = if supports_install_command
      "#{helper} uninstall --binary-path #{helper}"
    else
      "#{helper} -uninstall"
    end
    <<~EOS
      Install the Tailchrome browser extension from the Chrome Web Store or Firefox Add-ons.

      After installing, disconnect Tailchrome, close your browsers, and register
      the helper for your user (without sudo):
        #{install_command}
      New helper releases register the stable Homebrew opt path, so no
      re-registration is needed after a normal brew upgrade. The pinned legacy
      release still uses its compatible runtime-copy command above.
      Reopen your browser when registration finishes.

      Before brew uninstall, remove this helper's browser registrations:
        #{uninstall_command}
      Run this in each account that registered the helper.
      Tailscale identities and profile data are preserved; Homebrew removes the executable.
    EOS
  end

  test do
    assert_equal "v#{version}", shell_output("#{bin}/tailscale-browser-ext -version").strip
    supports_install_command = shell_output("#{bin}/tailscale-browser-ext --help 2>&1").include?("--binary-path")
    if supports_install_command
      system bin/"tailscale-browser-ext", "install", "--binary-path", opt_bin/"tailscale-browser-ext"
    else
      system bin/"tailscale-browser-ext", "-install-now"
    end

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
    expected_path = supports_install_command ? (opt_bin/"tailscale-browser-ext").to_s : runtime.to_s
    assert_equal expected_path, JSON.parse(chrome.read).fetch("path")
    assert_equal ["chrome-extension://bhfeceecialgilpedkoflminjgcjljll/"],
                 JSON.parse(chrome.read).fetch("allowed_origins")
    assert_equal expected_path, JSON.parse(firefox.read).fetch("path")
    assert_equal ["tailchrome@tesseras.org"], JSON.parse(firefox.read).fetch("allowed_extensions")

    if supports_install_command
      system bin/"tailscale-browser-ext", "uninstall", "--binary-path", opt_bin/"tailscale-browser-ext"
    else
      system bin/"tailscale-browser-ext", "-uninstall"
    end
    refute_path_exists runtime unless supports_install_command
    refute_path_exists chrome
    refute_path_exists firefox
    assert_path_exists bin/"tailscale-browser-ext"
    assert_path_exists bin/"tailchrome"
  end
end
