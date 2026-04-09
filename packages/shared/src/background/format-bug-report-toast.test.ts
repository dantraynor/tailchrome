import { describe, it, expect } from "vitest";
import { extractBugReportReference, formatBugReportForToast } from "./format-bug-report-toast";
import { TAILCHROME_PROJECT_URL } from "../constants";

describe("extractBugReportReference", () => {
  it("joins a BUG id split across lines", () => {
    const raw = `BUG-
298c05aa17d1e50c5981
59ac778206a5c86d7b35
ca3508e55639ee83279
b58d5-
20260409041630Z-
1a2fba0bafa1b05e`;
    expect(extractBugReportReference(raw)).toBe(
      "BUG-298c05aa17d1e50c598159ac778206a5c86d7b35ca3508e55639ee83279b58d5-20260409041630Z-1a2fba0bafa1b05e",
    );
  });
});

describe("formatBugReportForToast", () => {
  it("explains empty body and points to support", () => {
    const s = formatBugReportForToast("");
    expect(s).toContain("Bug report was submitted");
    expect(s).toContain(TAILCHROME_PROJECT_URL);
  });

  it("strips dash banners and emits a single-line BUG reference plus instructions", () => {
    const raw = `----------------------------------------
BUG-
298c05aa17d1e50c5981
59ac778206a5c86d7b35
----------------------------------------`;
    const s = formatBugReportForToast(raw);
    expect(s).toContain("How to get help");
    expect(s).toContain(TAILCHROME_PROJECT_URL);
    expect(s).toContain("BUG-298c05aa17d1e50c598159ac778206a5c86d7b35");
    expect(s).not.toContain("----------------------------------------");
  });

  it("handles body that is only separators", () => {
    const s = formatBugReportForToast("----------------------------------------");
    expect(s).toContain("Bug report was submitted");
    expect(s).toContain(TAILCHROME_PROJECT_URL);
  });

  it("preserves non-BUG content when no BUG- prefix", () => {
    const s = formatBugReportForToast("Line one\nLine two");
    expect(s).toContain("Line one");
    expect(s).toContain("How to get help");
  });
});
