// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildDownloadURL,
  buildRunCommand,
  detectArch,
  installerDownloads,
  renderInstallFlow,
  requestNativeHostRetries,
} from "./install-helpers";
import { sendMessage } from "../popup";
import { detectPlatform } from "../utils";

vi.mock("../popup", () => ({
  sendMessage: vi.fn(),
}));

vi.mock("../utils", () => ({
  copyToClipboard: vi.fn(),
  detectPlatform: vi.fn(() => "windows"),
  showToast: vi.fn(),
}));

function platformInfo(arch: string): chrome.runtime.PlatformInfo {
  return {
    arch: arch as chrome.runtime.PlatformInfo["arch"],
    os: "linux",
  };
}

function mockPlatformArch(arch: string): void {
  chrome.runtime.getPlatformInfo = vi
    .fn()
    .mockResolvedValue(platformInfo(arch)) as typeof chrome.runtime.getPlatformInfo;
}

function mockCallbackPlatformArch(arch: string): void {
  chrome.runtime.getPlatformInfo = vi.fn(
    (callback: (info: chrome.runtime.PlatformInfo) => void) => {
      callback(platformInfo(arch));
    },
  ) as unknown as typeof chrome.runtime.getPlatformInfo;
}

function setNavigatorIdentity(platform: string, userAgent: string): void {
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: platform,
  });
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
}

const REDUCED_CHROMIUM_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36";

describe("installerDownloads", () => {
  it("returns the macOS package asset", () => {
    expect(installerDownloads("macos")).toEqual([
      {
        filename: "tailchrome-helper-macos.pkg",
        label: "Download macOS installer (.pkg)",
        url: "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-helper-macos.pkg",
      },
    ]);
  });

  it("returns the Windows MSI asset", () => {
    expect(installerDownloads("windows")).toEqual([
      {
        filename: "tailchrome-helper-windows-x64.msi",
        label: "Download Windows installer (.msi)",
        url: "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-helper-windows-x64.msi",
      },
    ]);
  });

  it("returns both Linux package assets", () => {
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

  it("routes Linux ARM64 through the version-pinned verified installer", () => {
    expect(installerDownloads("linux", "arm64")).toEqual([
      {
        filename: "tailchrome-install.sh",
        label: "Download verified Linux ARM64 installer",
        url: "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-install.sh",
      },
    ]);
    expect(buildDownloadURL("linux", "arm64")).toBe(
      "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-install.sh",
    );
    expect(buildRunCommand("linux", "arm64")).toBe(
      'bash ~/Downloads/tailchrome-install.sh --version "v0.1.13"',
    );
  });

  it("falls back to the release page for unknown platforms", () => {
    expect(installerDownloads("unknown")).toEqual([
      {
        filename: null,
        label: "Open companion release",
        url: "https://github.com/dantraynor/tailchrome/releases/tag/v0.1.13",
      },
    ]);
  });

  it.each(["macos", "linux", "windows"] as const)(
    "does not guess an installer for unsupported %s architectures",
    (platform) => {
      expect(installerDownloads(platform, "unknown")).toEqual([
        {
          filename: null,
          label: "Open companion release",
          url: "https://github.com/dantraynor/tailchrome/releases/tag/v0.1.13",
        },
      ]);
      expect(buildDownloadURL(platform, "unknown")).toBe(
        "https://github.com/dantraynor/tailchrome/releases/tag/v0.1.13",
      );
      expect(buildRunCommand(platform, "unknown")).toBeNull();
    },
  );

  it("keeps raw binary downloads available as a fallback", () => {
    expect(buildDownloadURL("windows")).toBe(
      "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailscale-browser-ext-windows-amd64.exe",
    );
    expect(buildDownloadURL("linux")).toBe(
      "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailscale-browser-ext-linux-amd64",
    );
  });
});

describe("detectArch", () => {
  beforeEach(() => {
    setNavigatorIdentity("Linux x86_64", REDUCED_CHROMIUM_UA);
    (
      chrome.runtime as unknown as {
        lastError: chrome.runtime.LastError | null;
      }
    ).lastError = null;
  });

  it.each([
    ["arm", "unknown"],
    ["arm64", "arm64"],
    ["aarch64", "arm64"],
    ["x86-64", "amd64"],
    ["x86-32", "unknown"],
    ["mips", "unknown"],
  ] as const)(
    "maps Promise-based runtime architecture %s to %s",
    async (runtimeArch, expected) => {
      mockPlatformArch(runtimeArch);

      await expect(detectArch()).resolves.toBe(expected);
      expect(chrome.runtime.getPlatformInfo).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["arm64", "aarch64"] as const)(
    "reads callback-only runtime architecture %s under reduced x86 metadata",
    async (runtimeArch) => {
      mockCallbackPlatformArch(runtimeArch);

      await expect(detectArch()).resolves.toBe("arm64");
      expect(chrome.runtime.getPlatformInfo).toHaveBeenCalledTimes(1);
    },
  );

  it("does not treat callback-only 32-bit ARM as ARM64", async () => {
    mockCallbackPlatformArch("arm");

    await expect(detectArch()).resolves.toBe("unknown");
  });

  it("settles once if an implementation invokes the callback and returns a Promise", async () => {
    chrome.runtime.getPlatformInfo = vi.fn(
      (callback: (info: chrome.runtime.PlatformInfo) => void) => {
        callback(platformInfo("arm64"));
        return Promise.resolve(platformInfo("x86-64"));
      },
    ) as unknown as typeof chrome.runtime.getPlatformInfo;

    await expect(detectArch()).resolves.toBe("arm64");
  });

  it("falls back when a callback reports runtime.lastError", async () => {
    const runtimeMock = chrome.runtime as unknown as {
      lastError: chrome.runtime.LastError | null;
    };
    chrome.runtime.getPlatformInfo = vi.fn(
      (callback: (info: chrome.runtime.PlatformInfo) => void) => {
        runtimeMock.lastError = { message: "platform lookup failed" };
        callback(platformInfo("arm64"));
        runtimeMock.lastError = null;
      },
    ) as unknown as typeof chrome.runtime.getPlatformInfo;

    await expect(detectArch()).resolves.toBe("amd64");
  });

  it("falls back to navigator architecture when the runtime lookup fails", async () => {
    chrome.runtime.getPlatformInfo = vi
      .fn()
      .mockRejectedValue(
        new Error("platform lookup failed"),
      ) as typeof chrome.runtime.getPlatformInfo;
    setNavigatorIdentity("Linux aarch64", REDUCED_CHROMIUM_UA);

    await expect(detectArch()).resolves.toBe("arm64");
  });

  it("defaults to amd64 when a failed lookup leaves only reduced x86 values", async () => {
    chrome.runtime.getPlatformInfo = vi
      .fn()
      .mockRejectedValue(
        new Error("platform lookup failed"),
      ) as typeof chrome.runtime.getPlatformInfo;

    await expect(detectArch()).resolves.toBe("amd64");
  });

  it("does not guess when failed lookup metadata is unsupported", async () => {
    chrome.runtime.getPlatformInfo = vi
      .fn()
      .mockRejectedValue(
        new Error("platform lookup failed"),
      ) as typeof chrome.runtime.getPlatformInfo;
    setNavigatorIdentity(
      "Linux i686",
      "Mozilla/5.0 (X11; Linux i686) Gecko/20100101 Firefox/152.0",
    );

    await expect(detectArch()).resolves.toBe("unknown");
  });
});

describe("requestNativeHostRetries", () => {
  beforeEach(() => {
    vi.mocked(sendMessage).mockClear();
  });

  it("immediately asks the background worker to poll native-host discovery", () => {
    requestNativeHostRetries();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ type: "retry-native-host" });
  });
});

describe("renderInstallFlow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(detectPlatform).mockReturnValue("windows");
    setNavigatorIdentity("Linux x86_64", REDUCED_CHROMIUM_UA);
    mockPlatformArch("x86-64");
    vi.mocked(sendMessage).mockClear();
    chrome.tabs.create = vi.fn().mockResolvedValue(undefined) as unknown as typeof chrome.tabs.create;
    document.body.textContent = "";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["install", "update"] as const)(
    "requests native-host retries from the %s view installer button",
    async (mode) => {
      const root = document.createElement("div");
      document.body.appendChild(root);

      await renderInstallFlow(root, { mode, hostVersion: "0.1.0" });

      root.querySelector<HTMLAnchorElement>(".install-pkg-cta a")?.click();

      // The retry request must go out synchronously in the click handler:
      // opening the download tab closes the popup surface right after.
      expect(sendMessage).toHaveBeenCalledWith({ type: "retry-native-host" });
      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-helper-windows-x64.msi",
      });
    },
  );

  it("renders both Linux package links with install commands", async () => {
    vi.mocked(detectPlatform).mockReturnValue("linux");
    const root = document.createElement("div");
    document.body.appendChild(root);

    await renderInstallFlow(root, { mode: "install", hostVersion: "0.1.0" });

    const links = [...root.querySelectorAll<HTMLAnchorElement>(".install-pkg-cta a")];
    expect(links.map((link) => link.href)).toEqual([
      "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-helper-linux-amd64.deb",
      "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-helper-linux-x86_64.rpm",
    ]);
    expect(root.textContent).toContain("sudo apt install");
    expect(root.textContent).toContain("sudo dnf install");
  });

  it("renders the pinned Linux ARM64 installer instead of an unchecked binary", async () => {
    vi.mocked(detectPlatform).mockReturnValue("linux");
    mockPlatformArch("aarch64");
    const root = document.createElement("div");
    document.body.appendChild(root);

    await renderInstallFlow(root, {
      mode: "install",
      hostVersion: "0.1.0",
    });

    const links = [
      ...root.querySelectorAll<HTMLAnchorElement>(".install-pkg-cta a"),
    ];
    expect(links.map((link) => link.href)).toEqual([
      "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-install.sh",
    ]);
    expect(root.textContent).toContain(
      'bash ~/Downloads/tailchrome-install.sh --version "v0.1.13"',
    );
    expect(root.textContent).toContain("verifies its SHA-256 checksum");
    expect(root.textContent).toContain(
      "test \"$(wc -l < tailchrome-install.sh.sha256)\" -eq 1",
    );
    expect(root.textContent).toContain("sha256sum --check");
    expect(root.textContent).toContain("gh attestation verify");
    expect(root.textContent).toContain("--hostname github.com");
    expect(root.textContent).toContain(
      "less ~/Downloads/tailchrome-install.sh",
    );
    expect(
      root.querySelector<HTMLAnchorElement>(
        'a[href="https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/SHA256SUMS.txt"]',
      ),
    ).not.toBeNull();
    expect(root.textContent).not.toContain(
      "tailscale-browser-ext-linux-arm64",
    );
    expect(root.textContent).not.toContain("chmod +x");
    expect(root.querySelector(".install-advanced-toggle")).toBeNull();

    links[0]?.click();
    expect(sendMessage).toHaveBeenCalledWith({ type: "retry-native-host" });
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailchrome-install.sh",
    });
  });

  it("links to the releases page on unknown platforms", async () => {
    vi.mocked(detectPlatform).mockReturnValue("unknown");
    const root = document.createElement("div");
    document.body.appendChild(root);

    await renderInstallFlow(root, { mode: "install", hostVersion: "0.1.0" });

    const links = [...root.querySelectorAll<HTMLAnchorElement>(".install-pkg-cta a")];
    expect(links.map((link) => link.href)).toEqual([
      "https://github.com/dantraynor/tailchrome/releases/tag/v0.1.13",
    ]);
  });

  it("does not offer x64 Linux commands for unsupported runtime architectures", async () => {
    vi.mocked(detectPlatform).mockReturnValue("linux");
    mockPlatformArch("arm");
    const root = document.createElement("div");
    document.body.appendChild(root);

    await renderInstallFlow(root, { mode: "install", hostVersion: "0.1.0" });

    const links = [
      ...root.querySelectorAll<HTMLAnchorElement>(".install-pkg-cta a"),
    ];
    expect(links.map((link) => link.href)).toEqual([
      "https://github.com/dantraynor/tailchrome/releases/tag/v0.1.13",
    ]);
    expect(root.textContent).toContain("No compatible installer was selected");
    expect(root.textContent).toContain("does not guess an installer");
    expect(root.textContent).not.toContain("sudo apt install");
    expect(root.textContent).not.toContain("tailchrome-install.sh");
    expect(root.querySelector(".install-advanced-toggle")).toBeNull();
  });

  it("reveals the raw binary fallback and requests retries from its download link", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);

    await renderInstallFlow(root, { mode: "install", hostVersion: "0.1.0" });

    const toggle = root.querySelector<HTMLButtonElement>(".install-advanced-toggle")!;
    const section = root.querySelector<HTMLElement>(".install-advanced-section")!;
    expect(section.classList.contains("hidden")).toBe(true);

    toggle.click();
    expect(section.classList.contains("hidden")).toBe(false);
    expect(toggle.textContent).toBe("Hide raw binary fallback");

    section.querySelector<HTMLAnchorElement>("a")!.click();
    expect(sendMessage).toHaveBeenCalledWith({ type: "retry-native-host" });
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: "https://github.com/dantraynor/tailchrome/releases/download/v0.1.13/tailscale-browser-ext-windows-amd64.exe",
    });
  });

  it("does not overwrite a newer view after a delayed platform lookup", async () => {
    let resolvePlatformInfo!: (info: chrome.runtime.PlatformInfo) => void;
    chrome.runtime.getPlatformInfo = vi.fn(
      () =>
        new Promise<chrome.runtime.PlatformInfo>((resolve) => {
          resolvePlatformInfo = resolve;
        }),
    ) as typeof chrome.runtime.getPlatformInfo;
    const root = document.createElement("div");
    document.body.appendChild(root);

    const render = renderInstallFlow(root, {
      mode: "install",
      hostVersion: "0.1.0",
    });
    root.textContent = "A newer view";
    resolvePlatformInfo(platformInfo("x86-64"));
    await render;

    expect(root.textContent).toBe("A newer view");
  });
});
