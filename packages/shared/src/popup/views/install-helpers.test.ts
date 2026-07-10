// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildDownloadURL,
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

describe("installerDownloads", () => {
  it("returns the macOS package asset", () => {
    expect(installerDownloads("macos")).toEqual([
      {
        filename: "tailchrome-helper-macos.pkg",
        label: "Download macOS installer (.pkg)",
        url: "https://github.com/dantraynor/tailchrome/releases/latest/download/tailchrome-helper-macos.pkg",
      },
    ]);
  });

  it("returns the Windows MSI asset", () => {
    expect(installerDownloads("windows")).toEqual([
      {
        filename: "tailchrome-helper-windows-x64.msi",
        label: "Download Windows installer (.msi)",
        url: "https://github.com/dantraynor/tailchrome/releases/latest/download/tailchrome-helper-windows-x64.msi",
      },
    ]);
  });

  it("returns both Linux package assets", () => {
    expect(installerDownloads("linux")).toEqual([
      {
        filename: "tailchrome-helper-linux-amd64.deb",
        label: "Download .deb (Debian/Ubuntu)",
        url: "https://github.com/dantraynor/tailchrome/releases/latest/download/tailchrome-helper-linux-amd64.deb",
      },
      {
        filename: "tailchrome-helper-linux-x86_64.rpm",
        label: "Download .rpm (Fedora/RHEL)",
        url: "https://github.com/dantraynor/tailchrome/releases/latest/download/tailchrome-helper-linux-x86_64.rpm",
      },
    ]);
  });

  it("falls back to the release page for unknown platforms", () => {
    expect(installerDownloads("unknown")).toEqual([
      {
        filename: null,
        label: "Open latest release",
        url: "https://github.com/dantraynor/tailchrome/releases/latest",
      },
    ]);
  });

  it("keeps raw binary downloads available as a fallback", () => {
    expect(buildDownloadURL("windows")).toBe(
      "https://github.com/dantraynor/tailchrome/releases/latest/download/tailscale-browser-ext-windows-amd64.exe",
    );
    expect(buildDownloadURL("linux")).toBe(
      "https://github.com/dantraynor/tailchrome/releases/latest/download/tailscale-browser-ext-linux-amd64",
    );
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
    vi.mocked(sendMessage).mockClear();
    chrome.tabs.create = vi.fn().mockResolvedValue(undefined) as unknown as typeof chrome.tabs.create;
    document.body.textContent = "";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["install", "update"] as const)(
    "requests native-host retries from the %s view installer button",
    (mode) => {
      const root = document.createElement("div");
      document.body.appendChild(root);

      renderInstallFlow(root, { mode, hostVersion: "0.1.0" });

      root.querySelector<HTMLAnchorElement>(".install-pkg-cta a")?.click();

      // The retry request must go out synchronously in the click handler:
      // opening the download tab closes the popup surface right after.
      expect(sendMessage).toHaveBeenCalledWith({ type: "retry-native-host" });
      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: "https://github.com/dantraynor/tailchrome/releases/latest/download/tailchrome-helper-windows-x64.msi",
      });
    },
  );

  it("renders both Linux package links with install commands", () => {
    vi.mocked(detectPlatform).mockReturnValue("linux");
    const root = document.createElement("div");
    document.body.appendChild(root);

    renderInstallFlow(root, { mode: "install", hostVersion: "0.1.0" });

    const links = [...root.querySelectorAll<HTMLAnchorElement>(".install-pkg-cta a")];
    expect(links.map((link) => link.href)).toEqual([
      "https://github.com/dantraynor/tailchrome/releases/latest/download/tailchrome-helper-linux-amd64.deb",
      "https://github.com/dantraynor/tailchrome/releases/latest/download/tailchrome-helper-linux-x86_64.rpm",
    ]);
    expect(root.textContent).toContain("sudo apt install");
    expect(root.textContent).toContain("sudo dnf install");
  });

  it("links to the releases page on unknown platforms", () => {
    vi.mocked(detectPlatform).mockReturnValue("unknown");
    const root = document.createElement("div");
    document.body.appendChild(root);

    renderInstallFlow(root, { mode: "install", hostVersion: "0.1.0" });

    const links = [...root.querySelectorAll<HTMLAnchorElement>(".install-pkg-cta a")];
    expect(links.map((link) => link.href)).toEqual([
      "https://github.com/dantraynor/tailchrome/releases/latest",
    ]);
  });

  it("reveals the raw binary fallback and requests retries from its download link", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);

    renderInstallFlow(root, { mode: "install", hostVersion: "0.1.0" });

    const toggle = root.querySelector<HTMLButtonElement>(".install-advanced-toggle")!;
    const section = root.querySelector<HTMLElement>(".install-advanced-section")!;
    expect(section.classList.contains("hidden")).toBe(true);

    toggle.click();
    expect(section.classList.contains("hidden")).toBe(false);
    expect(toggle.textContent).toBe("Hide raw binary fallback");

    section.querySelector<HTMLAnchorElement>("a")!.click();
    expect(sendMessage).toHaveBeenCalledWith({ type: "retry-native-host" });
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: "https://github.com/dantraynor/tailchrome/releases/latest/download/tailscale-browser-ext-windows-amd64.exe",
    });
  });
});
