import { TAILCHROME_PROJECT_URL } from "../constants";

/**
 * Tailscale's BugReport marker sometimes arrives with newlines inside the BUG-… id.
 * Collapse whitespace and extract one copyable reference line.
 */
export function extractBugReportReference(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, "").trim();
  if (!collapsed) return null;
  const m = collapsed.match(/\bBUG-[A-Za-z0-9-]+\b/);
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
      "Diagnostics uploaded. No reference came back.\n\n"
      + `${TAILCHROME_PROJECT_URL}`
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
      "Diagnostics uploaded. No reference line to copy.\n\n"
      + `${TAILCHROME_PROJECT_URL}`
    );
  }

  const reference = extractBugReportReference(cleanedBody);

  const tail = `\n\n${TAILCHROME_PROJECT_URL}`;

  if (reference) {
    return `Diagnostics uploaded.\n\nCopy if support asks:\n${reference}${tail}`;
  }

  return (
    `Diagnostics uploaded.\n\nCopy if support asks:\n${cleanedBody}${tail}\n\n`
    + "(If that looks broken, copy from the lines above.)"
  );
}