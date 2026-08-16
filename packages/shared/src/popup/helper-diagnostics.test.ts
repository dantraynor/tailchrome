// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseState } from "../__test__/fixtures";
import {
  buildCurrentHelperDiagnosticReport,
  copyHelperDiagnosticReport,
  exportHelperDiagnosticReport,
  HELPER_DIAGNOSTIC_FILENAME,
} from "./helper-diagnostics";

describe("helper diagnostic report actions", () => {
  beforeEach(() => {
    chrome.runtime.getPlatformInfo = vi.fn().mockResolvedValue({
      os: "linux",
      arch: "x86-64",
      nacl_arch: "x86-64",
    }) as typeof chrome.runtime.getPlatformInfo;
    chrome.runtime.getManifest = vi.fn().mockReturnValue({
      version: "0.1.12",
      browser_specific_settings: { gecko: { id: "tailchrome@example.test" } },
    }) as typeof chrome.runtime.getManifest;
  });

  it("builds the report from runtime platform and manifest information", async () => {
    const report = await buildCurrentHelperDiagnosticReport(
      baseState({
        hostVersion: "0.1.11",
        helperFailure: {
          kind: "helper-unavailable",
          diagnosticCode: "native-host-unavailable",
          diagnosticMessage: "fixture native host missing",
        },
      }),
    );

    expect(report).toContain("extensionVersion: 0.1.12");
    expect(report).toContain("releaseVersion: 0.1.12");
    expect(report).toContain("os: linux");
    expect(report).toContain("architecture: x86-64");
    expect(report).toContain("browserFamily: firefox");
    expect(report).toContain("fixture native host missing");
  });

  it("copies the exact formatted report", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await copyHelperDiagnosticReport("same allowlisted report");

    expect(writeText).toHaveBeenCalledWith("same allowlisted report");
  });

  it("exports the exact report with a stable filename and revokes the URL", async () => {
    let exportedBlob: Blob | null = null;
    const createObjectURL = vi.fn((blob: Blob) => {
      exportedBlob = blob;
      return "blob:helper-report";
    });
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    exportHelperDiagnosticReport("same allowlisted report");

    expect(click).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector<HTMLAnchorElement>(
        `a[download="${HELPER_DIAGNOSTIC_FILENAME}"]`,
      ),
    ).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:helper-report");
    expect(exportedBlob).not.toBeNull();
    expect(await exportedBlob!.text()).toBe("same allowlisted report");
  });
});
