import { TAILCHROME_PROJECT_URL } from "../constants";

/**
 * Tailscale's BugReport marker sometimes arrives with newlines inside the BUG-… id.
 * Collapse whitespace and extract one copyable reference line.
 */
export function extractBugReportReference(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, "").trim();
  if (!collapsed) return null;
  const i = collapsed.indexOf("BUG-");
  if (i < 0) return null;
  const fromBug = collapsed.slice(i);
  const m = fromBug.match(/^BUG-[A-Za-z0-9-]+/);
  return m?.[0] ?? null;
}

/**
 * Formats the raw marker returned by Tailscale's BugReport local API for the popup.
 * The string often includes banner lines of dashes; we surface the reference clearly.
 */
export function formatBugReportForToast(body: string): string {
  const raw = body.trim();
  if (!raw) {
    return (
      "Bug report was submitted.\n\n"
      + "For Tailchrome help, visit:\n"
      + `${TAILCHROME_PROJECT_URL}\n\n`
      + "No reference ID was returned here — describe what went wrong (and that you used the extension’s bug report)."
    );
  }

  const lines = raw.split(/\r?\n/);
  const trimmedLines = lines.map((l) => l.trimEnd());
  const withoutSeparators = trimmedLines.filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (t.length >= 6 && /^[-–—_=.\s]+$/.test(t)) return false;
    return true;
  });

  const cleanedBody = (withoutSeparators.length > 0 ? withoutSeparators : trimmedLines)
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!cleanedBody || !/[A-Za-z0-9]/.test(cleanedBody)) {
    return (
      "Bug report was submitted.\n\n"
      + "For Tailchrome help, visit:\n"
      + `${TAILCHROME_PROJECT_URL}\n\n`
      + "The response did not include a readable reference — describe the issue in a GitHub issue if you can."
    );
  }

  // Extract from banner-free text only — otherwise separator lines glue onto the hex id.
  const reference = extractBugReportReference(cleanedBody);

  const howTo = [
    "Your diagnostics were uploaded to Tailscale and are linked to the reference below.",
    "",
    "How to get help:",
    `• ${TAILCHROME_PROJECT_URL}`,
    "• Open an issue there for Tailchrome bugs; include the BUG-… line below when relevant.",
    "• For Tailscale account or tailnet issues, use https://tailscale.com/contact/support and paste the same reference.",
    "",
    "Reference — copy this entire line:",
  ].join("\n");

  if (reference) {
    return `${howTo}\n${reference}`;
  }

  return (
    `${howTo}\n${cleanedBody}\n\n`
    + "(If that text looks broken, select and copy it from the lines above.)"
  );
}
