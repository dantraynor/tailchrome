// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  binaryFilename,
  buildDownloadURL,
  installerDownloads,
  normalizeInstallerPlatform,
  renderInstallFlow,
  requestNativeHostRetries,
} from "./install-helpers";
import { sendMessage } from "../popup";
import { copyToClipboard } from "../utils";
import { baseState } from "../../__test__/fixtures";

vi.mock("../popup", () => ({
  sendMessage: vi.fn(),
}));

vi.mock("../utils", () => ({
  copyToClipboard: vi.fn(),
  showToast: vi.fn(),
}));

const release = "https://github.com/dantraynor/tailchrome/releases";
const version = "v0.1.13";

function setPlatform(os: string, arch: string): void {
  chrome.runtime.getPlatformInfo = vi.fn().mockResolvedValue({ os, arch }) as typeof chrome.runtime.getPlatformInfo;
}

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

  it("marks unsupported values without guessing", () => {
    expect(normalizeInstallerPlatform({ os: "cros", arch: "x86-64" })).toEqual({
      platform: "unknown",
      architecture: "amd64",
    });
    expect(normalizeInstallerPlatform({ os: "linux", arch: "riscv64" })).toEqual({
      platform: "linux",
      architecture: "unknown",
    });
  });
});

describe("installer assets", () => {
  it("uses the pinned per-user asset for each supported primary flow", () => {
    expect(installerDownloads("linux", "amd64")[0]).toMatchObject({
      filename: "tailchrome-install.sh",
      url: `${release}/download/${version}/tailchrome-install.sh`,
    });
    expect(installerDownloads("macos", "arm64")[0]).toMatchObject({
      filename: "tailchrome-helper-macos-user.zip",
    });
    expect(installerDownloads("windows", "amd64")[0]).toMatchObject({
      filename: "tailchrome-helper-windows-x64.msi",
    });
    expect(installerDownloads("windows", "arm64")[0]).toMatchObject({
      filename: "tailchrome-install.ps1",
    });
  });

  it("reports the native Windows ARM64 raw asset", () => {
    expect(binaryFilename("windows", "amd64")).toBe(
      "tailscale-browser-ext-windows-amd64.exe",
    );
    expect(binaryFilename("windows", "arm64")).toBe(
      "tailscale-browser-ext-windows-arm64.exe",
    );
    expect(buildDownloadURL("windows", "arm64")).toBe(
      `${release}/download/${version}/tailscale-browser-ext-windows-arm64.exe`,
    );
  });

  it("uses release information instead of an unsupported asset", () => {
    expect(installerDownloads("linux", "unknown")).toEqual([
      {
        filename: null,
        label: "Open release information",
        url: `${release}/tag/${version}`,
      },
    ]);
    expect(installerDownloads("unknown", "unknown")[0]?.filename).toBeNull();
    expect(buildDownloadURL("windows", "unknown")).toBe(`${release}/tag/${version}`);
  });
});

describe("requestNativeHostRetries", () => {
  beforeEach(() => vi.mocked(sendMessage).mockClear());

  it("immediately asks the background worker to poll discovery", () => {
    requestNativeHostRetries("package");
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
    vi.mocked(copyToClipboard).mockClear();
    chrome.runtime.getManifest = vi.fn().mockReturnValue({ version: "0.1.13" }) as typeof chrome.runtime.getManifest;
    chrome.tabs.create = vi.fn().mockResolvedValue(undefined) as unknown as typeof chrome.tabs.create;
    document.body.textContent = "";
  });

  afterEach(() => vi.useRealTimers());

  it("shows one copyable, pinned Bash command on Linux", async () => {
    setPlatform("linux", "x86-64");
    const root = document.createElement("div");
    await renderInstallFlow(root, { mode: "install", state: baseState({ hostConnected: false }) });

    const primary = root.querySelector<HTMLElement>(".helper-install-primary")!;
    const command = primary.querySelector("code")!.textContent!;
    expect(command).toBe(
      `curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 '${release}/download/${version}/tailchrome-install.sh' | bash -s -- --version '${version}'`,
    );
    expect(primary.querySelector<HTMLButtonElement>("button")?.textContent).toBe("Copy command");
    expect(root.querySelector(".helper-install-alternatives")?.hasAttribute("open")).toBe(false);

    primary.querySelector<HTMLButtonElement>("button")!.click();
    expect(copyToClipboard).toHaveBeenCalledWith(command);
    expect(sendMessage).toHaveBeenCalledWith({ type: "retry-native-host", source: "fallback" });
  });

  it("keeps Linux package alternatives collapsed and starts discovery on package launch", async () => {
    setPlatform("linux", "x86-64");
    const root = document.createElement("div");
    await renderInstallFlow(root, { mode: "install", state: baseState({ hostConnected: false }) });

    const alternatives = root.querySelector<HTMLDetailsElement>("details")!;
    expect(alternatives.open).toBe(false);
    alternatives.open = true;
    const deb = [...alternatives.querySelectorAll<HTMLAnchorElement>("a")].find((link) => link.textContent?.includes("Debian"))!;
    deb.click();
    expect(sendMessage).toHaveBeenCalledWith({ type: "retry-native-host", source: "package" });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: `${release}/download/${version}/tailchrome-helper-linux-amd64.deb` });
  });

  it("makes the signed macOS per-user ZIP primary and keeps a shell option available", async () => {
    setPlatform("mac", "arm64");
    const root = document.createElement("div");
    await renderInstallFlow(root, { mode: "install", state: baseState({ hostConnected: false }) });

    const primary = root.querySelector<HTMLElement>(".helper-install-primary")!;
    expect(primary.textContent).toContain("signed app");
    const zip = primary.querySelector<HTMLAnchorElement>("a")!;
    expect(zip.href).toBe(`${release}/download/${version}/tailchrome-helper-macos-user.zip`);
    expect(root.textContent).toContain("Terminal option");
    expect(root.textContent).toContain("tailchrome-install.sh");
    expect(root.querySelector<HTMLDetailsElement>("details")!.open).toBe(false);
    zip.click();
    expect(sendMessage).toHaveBeenCalledWith({ type: "retry-native-host", source: "package" });
  });

  it("makes the per-user MSI primary on Windows x64", async () => {
    setPlatform("win", "x86-64");
    const root = document.createElement("div");
    await renderInstallFlow(root, { mode: "install", state: baseState({ hostConnected: false }) });

    const primary = root.querySelector<HTMLElement>(".helper-install-primary")!;
    expect(primary.textContent).toContain("without administrator access");
    const alternatives = root.querySelector<HTMLDetailsElement>("details")!;
    expect(alternatives.querySelector("code")!.textContent).not.toContain("-AllowUnsigned");
    expect(alternatives.textContent).toContain("again with -AllowUnsigned added at the end");
    expect(primary.querySelector<HTMLAnchorElement>("a")?.href).toBe(
      `${release}/download/${version}/tailchrome-helper-windows-x64.msi`,
    );
  });

  it("makes the native PowerShell command primary on Windows ARM64", async () => {
    setPlatform("win", "arm64");
    const root = document.createElement("div");
    await renderInstallFlow(root, { mode: "install", state: baseState({ hostConnected: false }) });

    const primary = root.querySelector<HTMLElement>(".helper-install-primary")!;
    const command = primary.querySelector("code")!.textContent!;
    expect(command).toContain(`${release}/download/${version}/tailchrome-install.ps1`);
    expect(command).toContain(`-Version '${version}'`);
    expect(primary.textContent).toContain("native ARM64");
    expect(command).not.toContain("-AllowUnsigned");
    expect(primary.textContent).toContain("again with -AllowUnsigned added at the end");
    const alternatives = root.querySelector<HTMLDetailsElement>("details")!;
    expect(alternatives.open).toBe(false);
    expect(alternatives.textContent).toContain("x64 package (runs under emulation)");
    expect(alternatives.textContent).toContain("x64 MSI (emulation alternative)");
    primary.querySelector<HTMLButtonElement>("button")!.click();
    expect(sendMessage).toHaveBeenCalledWith({ type: "retry-native-host", source: "fallback" });
  });

  it("executes the generated PowerShell one-liner without outer-shell expansion", async () => {
    setPlatform("win", "arm64");
    const root = document.createElement("div");
    await renderInstallFlow(root, { mode: "install", state: baseState({ hostConnected: false }) });
    const command = root.querySelector<HTMLElement>(".helper-install-primary code")!.textContent!;
    expect(command.startsWith("& ([scriptblock]::Create((Invoke-RestMethod -Uri '")).toBe(true);
    expect(command).not.toContain("$script");
    const expectedURL = release + "/download/" + version + "/tailchrome-install.ps1";
    const powershell = [
      "$ErrorActionPreference = 'Stop'",
      "function Invoke-RestMethod { param([string]$Uri); if ($Uri -ne '" + expectedURL + "') { throw 'unexpected URL' }; 'param([string]$Version) Write-Output (\"installed:\" + $Version)' }",
      command,
    ].join("\n");

    type ChildProcessModule = {
      execFileSync: (
        file: string,
        args: string[],
        options: { encoding: "utf8" },
      ) => string;
    };
    const processLike = (
      globalThis as typeof globalThis & {
        process?: {
          platform?: string;
          getBuiltinModule?: (name: string) => unknown;
        };
      }
    ).process;
    if (processLike?.platform !== "win32") {
      return;
    }
    const childProcess = processLike?.getBuiltinModule?.(
      "node:child_process",
    ) as ChildProcessModule | undefined;
    if (!childProcess) {
      return;
    }
    let output: string;
    try {
      output = childProcess.execFileSync(
        "pwsh",
        ["-NoProfile", "-NonInteractive", "-Command", powershell],
        { encoding: "utf8" },
      );
    } catch (error) {
      // Native Windows CI has PowerShell. Keep the shared unit suite usable
      // in minimal local environments where pwsh is not installed.
      if (String(error).includes("ENOENT")) {
        return;
      }
      throw error;
    }
    expect(output.trim()).toBe("installed:" + version);
  });

  it("preserves failure-specific copy, repair context, diagnostics, and retry", async () => {
    setPlatform("linux", "x86-64");
    const root = document.createElement("div");
    await renderInstallFlow(root, {
      mode: "install",
      state: baseState({
        hostConnected: false,
        repairRegistrationAvailable: true,
        helperFailure: {
          kind: "helper-not-allowed",
          diagnosticCode: "native-host-not-allowed",
          diagnosticMessage: "raw local detail",
        },
      }),
    });

    expect(root.textContent).toContain("This browser refused access to the registered helper.");
    expect(root.textContent).toContain("Repair registration for this browser");
    expect(root.textContent).toContain("Copy diagnostic report");
    expect(root.textContent).not.toContain("raw local detail");
    root.querySelector<HTMLButtonElement>(".helper-discovery-retry")!.click();
    expect(sendMessage).toHaveBeenCalledWith({ type: "retry-native-host", source: "manual" });
  });

  it("never embeds an unsafe manifest version in a command or asset URL", async () => {
    chrome.runtime.getManifest = vi.fn().mockReturnValue({ version: "0.1.13'; evil" }) as typeof chrome.runtime.getManifest;
    setPlatform("linux", "x86-64");
    const root = document.createElement("div");
    await renderInstallFlow(root, { mode: "install", state: baseState({ hostConnected: false }) });

    expect(root.querySelector("code")).toBeNull();
    expect(root.textContent).toContain("Open release information");
    expect(root.innerHTML).not.toContain("evil");
    expect(root.querySelector<HTMLAnchorElement>("a")?.href).toBe(release);
  });

  it("does not guess an asset for an unknown runtime platform", async () => {
    setPlatform("cros", "x86-64");
    const root = document.createElement("div");
    await renderInstallFlow(root, { mode: "install", state: baseState({ hostConnected: false }) });

    expect(root.querySelector<HTMLAnchorElement>(".helper-install-primary a")?.href).toBe(`${release}/tag/${version}`);
    expect(root.innerHTML).not.toContain("tailchrome-install.sh");
    expect(root.innerHTML).not.toContain("tailchrome-helper-windows-x64.msi");
    expect(root.textContent).toContain("will not guess an asset");
  });

  it.each([
    ["linux", "riscv64"],
    ["mac", "x86-32"],
    ["win", "x86-32"],
  ])("shows release information for %s with unknown architecture", async (os, arch) => {
    setPlatform(os, arch);
    const root = document.createElement("div");
    await renderInstallFlow(root, { mode: "install", state: baseState({ hostConnected: false }) });

    expect(root.querySelector(".helper-install-primary code")).toBeNull();
    expect(root.querySelector<HTMLAnchorElement>(".helper-install-primary a")?.href).toBe(release + "/tag/" + version);
    expect(root.querySelector("details")).toBeNull();
  });

  it("re-enables manual discovery retry after a quiet failure", async () => {
    setPlatform("win", "x86-64");
    const root = document.createElement("div");
    await renderInstallFlow(root, { mode: "install", state: baseState({ hostConnected: false }) });
    const retry = root.querySelector<HTMLButtonElement>(".helper-discovery-retry")!;
    retry.click();
    expect(retry.disabled).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(retry.disabled).toBe(false);
    expect(retry.textContent).toBe("Retry discovery");
  });
});
