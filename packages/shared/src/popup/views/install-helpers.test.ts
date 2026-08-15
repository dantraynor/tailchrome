// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  binaryFilename,
  buildDownloadURL,
  installerDownloads,
  normalizeInstallerPlatform,
  renderInstallFlow,
  requestNativeHostRetries,
} from "./install-helpers";
import { sendMessage } from "../popup";
import { baseState } from "../../__test__/fixtures";

vi.mock("../popup", () => ({
  sendMessage: vi.fn(),
}));

vi.mock("../utils", () => ({
  copyToClipboard: vi.fn(),
  showToast: vi.fn(),
}));

describe("normalizeInstallerPlatform", () => {
  it.each([
    [{ os: "linux", arch: "x86-64" }, { platform: "linux", architecture: "amd64" }],
    [{ os: "linux", arch: "arm64" }, { platform: "linux", architecture: "arm64" }],
    [{ os: "linux", arch: "aarch64" }, { platform: "linux", architecture: "arm64" }],
    [{ os: "mac", arch: "x86-64" }, { platform: "macos", architecture: "amd64" }],
    [{ os: "mac", arch: "arm64" }, { platform: "macos", architecture: "arm64" }],
    [{ os: "win", arch: "aarch64" }, { platform: "windows", architecture: "arm64" }],
  ])("normalizes runtime platform info %#", (input, expected) => {
    expect(normalizeInstallerPlatform(input)).toEqual(expected);
  });

  it("does not guess unsupported operating systems or architectures", () => {
    expect(
      normalizeInstallerPlatform({ os: "cros", arch: "x86-64" }),
    ).toEqual({ platform: "unknown", architecture: "amd64" });
    expect(
      normalizeInstallerPlatform({ os: "linux", arch: "riscv64" }),
    ).toEqual({ platform: "linux", architecture: "unknown" });
  });
});

describe("installerDownloads", () => {
  it("returns the macOS package asset", () => {
    expect(installerDownloads("macos", "arm64")).toEqual([
      {
        filename: "tailchrome-helper-macos.pkg",
        label: "Download macOS installer (.pkg)",
        url: "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-helper-macos.pkg",
      },
    ]);
  });

  it("does not offer macOS artifacts for an unsupported architecture", () => {
    expect(installerDownloads("macos", "unknown")).toEqual([
      {
        filename: null,
        label: "Open latest release",
        url: "https://github.com/dantraynor/tailchrome/releases/tag/v0.1.13",
      },
    ]);
    expect(binaryFilename("macos", "unknown")).toBeNull();
  });

  it.each(["amd64", "arm64"] as const)(
    "returns the Windows x64 MSI asset on %s",
    (architecture) => {
      expect(installerDownloads("windows", architecture)).toEqual([
        {
          filename: "tailchrome-helper-windows-x64.msi",
          label: "Download Windows installer (.msi)",
          url: "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-helper-windows-x64.msi",
        },
      ]);
    },
  );

  it("does not offer x64 Windows artifacts for an unsupported architecture", () => {
    expect(installerDownloads("windows", "unknown")).toEqual([
      {
        filename: null,
        label: "Open latest release",
        url: "https://github.com/dantraynor/tailchrome/releases/tag/v0.1.13",
      },
    ]);
    expect(binaryFilename("windows", "unknown")).toBeNull();
    expect(buildDownloadURL("windows", "unknown")).toBe(
      "https://github.com/dantraynor/tailchrome/releases/tag/v0.1.13",
    );
  });

  it("returns both Linux packages only for amd64", () => {
    expect(installerDownloads("linux", "amd64")).toEqual([
      {
        filename: "tailchrome-helper-linux-amd64.deb",
        label: "Download .deb (Debian/Ubuntu)",
        url: "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-helper-linux-amd64.deb",
      },
      {
        filename: "tailchrome-helper-linux-x86_64.rpm",
        label: "Download .rpm (Fedora/RHEL)",
        url: "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-helper-linux-x86_64.rpm",
      },
    ]);
  });

  it("uses the verified fallback installer instead of amd64 packages on Linux ARM64", () => {
    expect(installerDownloads("linux", "arm64")).toEqual([
      {
        filename: "tailchrome-install.sh",
        label: "Download verified Linux ARM64 installer",
        url: "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-install.sh",
      },
    ]);
  });

  it("falls back to the release page for unknown platforms", () => {
    expect(installerDownloads("unknown", "unknown")).toEqual([
      {
        filename: null,
        label: "Open latest release",
        url: "https://github.com/dantraynor/tailchrome/releases/tag/v0.1.13",
      },
    ]);
  });

  it("keeps raw binary downloads available as a fallback", () => {
    expect(buildDownloadURL("windows", "arm64")).toBe(
      "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailscale-browser-ext-windows-amd64.exe",
    );
    expect(buildDownloadURL("linux", "arm64")).toBe(
      "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailscale-browser-ext-linux-arm64",
    );
    expect(binaryFilename("macos", "amd64")).toBe(
      "tailscale-browser-ext-darwin-amd64",
    );
    expect(binaryFilename("macos", "arm64")).toBe(
      "tailscale-browser-ext-darwin-arm64",
    );
  });
});

describe("requestNativeHostRetries", () => {
  beforeEach(() => {
    vi.mocked(sendMessage).mockClear();
  });

  it("immediately asks the background worker to poll native-host discovery", () => {
    requestNativeHostRetries("package");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "retry-native-host",
      source: "package",
    });
  });
});

describe("renderInstallFlow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(sendMessage).mockClear();
    chrome.runtime.getPlatformInfo = vi.fn().mockResolvedValue({
      os: "win",
      arch: "x86-64",
    }) as typeof chrome.runtime.getPlatformInfo;
    chrome.tabs.create = vi.fn().mockResolvedValue(undefined) as unknown as typeof chrome.tabs.create;
    document.body.textContent = "";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    "requests package-sourced native-host retries from the installer button",
    async () => {
      const root = document.createElement("div");
      document.body.appendChild(root);

      await renderInstallFlow(root, {
        mode: "install",
        state: baseState({
          hostConnected: false,
          helperFailure: {
            kind: "helper-unavailable",
            diagnosticCode: "native-host-unavailable",
            diagnosticMessage: null,
          },
        }),
      });

      root.querySelector<HTMLAnchorElement>(".install-pkg-cta a")?.click();

      // The retry request must go out synchronously in the click handler:
      // opening the download tab closes the popup surface right after.
      expect(sendMessage).toHaveBeenCalledWith({
        type: "retry-native-host",
        source: "package",
      });
      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-helper-windows-x64.msi",
      });
    },
  );

  it("re-enables the discovery retry button after a quiet retry", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);

    await renderInstallFlow(root, {
      mode: "install",
      state: baseState({ hostConnected: false }),
    });

    const retry = root.querySelector<HTMLButtonElement>(
      ".helper-discovery-retry",
    )!;
    retry.click();

    expect(sendMessage).toHaveBeenCalledWith({
      type: "retry-native-host",
      source: "manual",
    });
    expect(retry.disabled).toBe(true);
    expect(retry.textContent).toBe("Retrying…");

    // A retry that keeps failing never re-renders the view (equivalent
    // failures are deduped), so the button must recover on its own.
    vi.advanceTimersByTime(3000);
    expect(retry.disabled).toBe(false);
    expect(retry.textContent).toBe("Retry discovery");
  });

  it("renders both Linux package links with install commands on amd64", async () => {
    chrome.runtime.getPlatformInfo = vi.fn().mockResolvedValue({
      os: "linux",
      arch: "x86-64",
    }) as typeof chrome.runtime.getPlatformInfo;
    const root = document.createElement("div");
    document.body.appendChild(root);

    await renderInstallFlow(root, {
      mode: "install",
      state: baseState({ hostConnected: false }),
    });

    const links = [...root.querySelectorAll<HTMLAnchorElement>(".install-pkg-cta a")];
    expect(links.map((link) => link.href)).toEqual([
      "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-helper-linux-amd64.deb",
      "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-helper-linux-x86_64.rpm",
    ]);
    expect(root.textContent).toContain("sudo apt install");
    expect(root.textContent).toContain("sudo dnf install");
  });

  it.each(["arm64", "aarch64"])(
    "uses the verified Linux ARM64 path for runtime arch %s",
    async (arch) => {
      chrome.runtime.getPlatformInfo = vi.fn().mockResolvedValue({
        os: "linux",
        arch,
      }) as typeof chrome.runtime.getPlatformInfo;
      const root = document.createElement("div");
      document.body.appendChild(root);

      await renderInstallFlow(root, {
        mode: "install",
        state: baseState({ hostConnected: false }),
      });

      const links = [
        ...root.querySelectorAll<HTMLAnchorElement>(".install-pkg-cta a"),
      ];
      expect(links.map((link) => link.href)).toEqual([
        "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-install.sh",
      ]);
      expect(root.textContent).toContain("Linux ARM64");
      expect(root.textContent).toContain("tailscale-browser-ext-linux-arm64");
      expect(root.textContent).not.toContain("sudo apt install");
      expect(root.textContent).not.toContain("sudo dnf install");
      expect(root.innerHTML).not.toContain("tailchrome-helper-linux-amd64");
      const runStep = root.querySelectorAll<HTMLElement>(".install-step")[1]!;
      expect(runStep.textContent).toContain("sha256sum --check");
      expect(runStep.textContent).toContain("gh attestation verify");
      expect(runStep.textContent).toContain(
        "less ~/Downloads/tailchrome-install.sh",
      );
      expect(
        runStep.querySelector<HTMLAnchorElement>(
          'a[href$="/SHA256SUMS.txt"]',
        ),
      ).not.toBeNull();
      expect(root.querySelector(".install-advanced-toggle")).toBeNull();
    },
  );

  it("links to the release page when runtime platform lookup fails", async () => {
    chrome.runtime.getPlatformInfo = vi.fn().mockRejectedValue(
      new Error("platform unavailable"),
    ) as typeof chrome.runtime.getPlatformInfo;
    const root = document.createElement("div");
    document.body.appendChild(root);

    await renderInstallFlow(root, {
      mode: "install",
      state: baseState({ hostConnected: false }),
    });

    const links = [...root.querySelectorAll<HTMLAnchorElement>(".install-pkg-cta a")];
    expect(links.map((link) => link.href)).toEqual([
      "https://github.com/dantraynor/tailchrome/releases/tag/v0.1.13",
    ]);
  });

  it("reveals the verified per-user repair and requests fallback retries", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);

    await renderInstallFlow(root, {
      mode: "install",
      state: baseState({ hostConnected: false }),
    });

    const toggle = root.querySelector<HTMLButtonElement>(
      ".install-advanced-toggle",
    )!;
    const section = root.querySelector<HTMLElement>(
      ".install-advanced-section",
    )!;
    expect(section.classList.contains("hidden")).toBe(true);

    toggle.click();
    expect(section.classList.contains("hidden")).toBe(false);
    expect(toggle.textContent).toBe("Hide verified per-user repair");
    expect(section.textContent).toContain(
      "powershell.exe -NoProfile -Command \"msiexec.exe /fa (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads\\tailchrome-helper-windows-x64.msi')\"",
    );

    section.querySelector<HTMLAnchorElement>("a")!.click();
    expect(sendMessage).toHaveBeenCalledWith({
      type: "retry-native-host",
      source: "fallback",
    });
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-helper-windows-x64.msi",
    });
  });

  it("promotes current-user registration repair after discovery retries are exhausted", async () => {
    chrome.runtime.getPlatformInfo = vi.fn().mockResolvedValue({
      os: "linux",
      arch: "x86-64",
    }) as typeof chrome.runtime.getPlatformInfo;
    const root = document.createElement("div");
    document.body.appendChild(root);

    await renderInstallFlow(root, {
      mode: "install",
      state: baseState({
        hostConnected: false,
        repairRegistrationAvailable: true,
        helperFailure: {
          kind: "helper-unavailable",
          diagnosticCode: "native-host-unavailable",
          diagnosticMessage: "raw fixture should stay local",
        },
      }),
    });

    expect(root.textContent).toContain(
      "Repair registration for this browser",
    );
    expect(root.textContent).toContain("current-user registration");
    expect(root.textContent).toContain("Verify, inspect, then run");
    expect(root.textContent).toContain(
      'bash ~/Downloads/tailchrome-install.sh --version "v0.1.13"',
    );
    expect(
      root.querySelector<HTMLAnchorElement>(".btn-primary")?.href,
    ).toBe(
      "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-install.sh",
    );
    expect(root.textContent!.indexOf("Verify, inspect, then run")).toBeLessThan(
      root.textContent!.indexOf("Or reinstall the release package"),
    );
    expect(root.textContent).not.toContain("raw fixture");
    expect(root.textContent).toContain("Copy diagnostic report");
  });

  it("does not duplicate the Linux ARM64 repair installer after retries are exhausted", async () => {
    chrome.runtime.getPlatformInfo = vi.fn().mockResolvedValue({
      os: "linux",
      arch: "arm64",
    }) as typeof chrome.runtime.getPlatformInfo;
    const root = document.createElement("div");

    await renderInstallFlow(root, {
      mode: "install",
      state: baseState({
        hostConnected: false,
        repairRegistrationAvailable: true,
      }),
    });

    expect(root.textContent).toContain("Download repair installer");
    expect(root.textContent).not.toContain("Or reinstall the release package");
    expect(
      root.querySelectorAll<HTMLAnchorElement>(
        'a[href$="/tailchrome-install.sh"]',
      ),
    ).toHaveLength(1);
    expect(root.textContent).toContain("Retry discovery");
  });

  it("promotes the installed macOS repair app before package reinstallation", async () => {
    chrome.runtime.getPlatformInfo = vi.fn().mockResolvedValue({
      os: "mac",
      arch: "arm64",
    }) as typeof chrome.runtime.getPlatformInfo;
    const root = document.createElement("div");

    await renderInstallFlow(root, {
      mode: "install",
      state: baseState({
        hostConnected: false,
        repairRegistrationAvailable: true,
      }),
    });

    expect(root.textContent).toContain(
      "/Applications/Tailchrome Helper.app",
    );
    expect(root.textContent!.indexOf("Open the installed repair app")).toBeLessThan(
      root.textContent!.indexOf("Or reinstall the release package"),
    );
  });

  it("notes x64 emulation on Windows ARM64", async () => {
    chrome.runtime.getPlatformInfo = vi.fn().mockResolvedValue({
      os: "win",
      arch: "arm64",
    }) as typeof chrome.runtime.getPlatformInfo;
    const root = document.createElement("div");

    await renderInstallFlow(root, {
      mode: "install",
      state: baseState({ hostConnected: false }),
    });

    expect(root.textContent).toContain("x64 emulation");
  });

  it("falls back to release information on unsupported Windows architectures", async () => {
    chrome.runtime.getPlatformInfo = vi.fn().mockResolvedValue({
      os: "win",
      arch: "x86-32",
    }) as typeof chrome.runtime.getPlatformInfo;
    const root = document.createElement("div");

    await renderInstallFlow(root, {
      mode: "install",
      state: baseState({ hostConnected: false }),
    });

    expect(
      root.querySelector<HTMLAnchorElement>(".install-pkg-cta a")?.href,
    ).toBe("https://github.com/dantraynor/tailchrome/releases/tag/v0.1.13");
    expect(root.innerHTML).not.toContain("tailchrome-helper-windows-x64.msi");
    expect(root.innerHTML).not.toContain(
      "tailscale-browser-ext-windows-amd64.exe",
    );
    expect(root.textContent).toContain("Open release information");
    expect(root.textContent).toContain("Review supported releases");
    expect(root.textContent).toContain("No compatible installer was selected");
    expect(root.textContent).not.toContain("double-click");
    expect(root.textContent).not.toContain("retry automatically");
  });

  it.each([
    ["linux", "riscv64"],
    ["mac", "x86-32"],
  ])(
    "does not offer a repair script on unsupported %s architecture %s",
    async (os, arch) => {
      chrome.runtime.getPlatformInfo = vi.fn().mockResolvedValue({
        os,
        arch,
      }) as typeof chrome.runtime.getPlatformInfo;
      const root = document.createElement("div");

      await renderInstallFlow(root, {
        mode: "install",
        state: baseState({
          hostConnected: false,
          repairRegistrationAvailable: true,
        }),
      });

      expect(root.innerHTML).not.toContain("tailchrome-install.sh");
      expect(root.innerHTML).not.toContain(
        "tailchrome-helper-linux-amd64.deb",
      );
      expect(root.innerHTML).not.toContain(
        "tailchrome-helper-linux-x86_64.rpm",
      );
      expect(root.textContent).toContain("Review supported releases");
      expect(root.textContent).toContain(
        "No compatible installer was selected",
      );
      expect(root.textContent).not.toContain("complete the installer");
      expect(root.textContent).not.toContain("retry automatically");
      expect(root.querySelector(".install-advanced-toggle")).toBeNull();
    },
  );

  it("renders evidence-based not-allowed and incompatible copy", async () => {
    const notAllowed = document.createElement("div");
    await renderInstallFlow(notAllowed, {
      mode: "install",
      state: baseState({
        hostConnected: false,
        helperFailure: {
          kind: "helper-not-allowed",
          diagnosticCode: "native-host-not-allowed",
          diagnosticMessage: null,
        },
      }),
    });
    expect(notAllowed.textContent).toContain(
      "This browser refused access to the registered helper.",
    );
    expect(notAllowed.textContent).toContain(
      "Repair registration for this browser",
    );
    expect(
      notAllowed.querySelector<HTMLAnchorElement>(".btn-primary")?.textContent,
    ).toBe("Download signed installer for repair");
    expect(notAllowed.textContent).not.toContain(
      "Or reinstall the release package",
    );

    const incompatible = document.createElement("div");
    await renderInstallFlow(incompatible, {
      mode: "install",
      state: baseState({
        hostConnected: false,
        helperFailure: {
          kind: "helper-incompatible",
          diagnosticCode: "future-protocol-incompatible",
          diagnosticMessage: null,
        },
      }),
    });
    expect(incompatible.textContent).toContain(
      "The helper and extension reported an incompatible protocol.",
    );
  });
});
