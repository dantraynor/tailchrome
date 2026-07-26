import type { TailscaleState } from "./types";

export const HELPER_DIAGNOSTIC_SCHEMA_VERSION = 1;
export const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 1_024;
export const MAX_HELPER_DIAGNOSTIC_REPORT_LENGTH = 8_192;

const DIAGNOSTIC_SCAN_LIMIT = MAX_DIAGNOSTIC_MESSAGE_LENGTH * 8;

/**
 * Makes a native-messaging detail safe to retain in memory for a local report.
 * The normal recovery UI never renders this value.
 */
export function sanitizeDiagnosticMessage(value: unknown): string | null {
  if (value == null) return null;

  let message: string;
  if (value instanceof Error) {
    message = value.message;
  } else if (typeof value === "string") {
    message = value;
  } else if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    message = String(value);
  } else {
    // Objects can contain arbitrary profile, peer, or authentication state.
    // A diagnostic code is sufficient when the detail is not plain text.
    return null;
  }

  message = message
    .slice(0, DIAGNOSTIC_SCAN_LIMIT)
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
      " ",
    )
    .replace(/\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s]+/gi, "[redacted-home]")
    .replace(/\/(?:Users|home)\/[^/\s]+/g, "[redacted-home]")
    .replace(
      /\b(extension[-_ ]?profile[-_ ]?id|magicdns(?:[-_ ]?suffix)?|tailnet|profile(?:[-_ ]?(?:id|name))?|peer(?:[-_ ]?(?:id|name))?|user(?:[-_ ]?(?:id|name|login[-_ ]?name))?|node(?:[-_ ]?(?:id|name))?|account(?:[-_ ]?(?:id|name))?)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^,;\r\n]+)/gi,
      "$1=[redacted-identity]",
    )
    .replace(
      /\b(?:HKEY_CURRENT_USER|HKCU)(?::)?\\[^,;\r\n]+/gi,
      "[redacted-registry]",
    )
    .replace(/\b(?:https?|ftp):\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/\bwww\.[^\s"'<>]+/gi, "[redacted-url]")
    .replace(
      /\bBearer\s+(?:"[^,;\r\n]*|'[^,;\r\n]*|[^\s,;]+)/gi,
      "Bearer [redacted-credential]",
    )
    .replace(
      /\b((?:access|refresh|id|auth|oauth|csrf|xsrf)[-_ ]?token|client[-_ ]?secret|api[-_ ]?key|session(?:[-_ ]?(?:id|key|token|cookie))?|set[-_ ]?cookie|cookie|auth(?:entication|orization)?|jwt|token|password|passphrase|secret|credential|private[-_ ]?key)\s*[:=]\s*(?:"[^,;\r\n]*|'[^,;\r\n]*|[^\s,;]+)/gi,
      "$1=[redacted-credential]",
    )
    .replace(/\btskey-[A-Za-z0-9_-]+\b/gi, "[redacted-credential]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[redacted-identity]")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      "[redacted-id]",
    )
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-address]")
    .replace(/\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]{0,39}\b/gi, "[redacted-address]")
    .replace(
      /\b(?=[A-Za-z0-9.-]*[A-Za-z])(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g,
      "[redacted-host]",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (!message) return null;
  return message.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH);
}

export type HelperDiagnosticBrowserFamily = "chromium" | "firefox";

export interface HelperDiagnosticPlatform {
  os: string;
  arch: string;
}

export interface HelperDiagnosticReportInput {
  state: TailscaleState;
  extensionVersion: string;
  releaseVersion: string;
  platform: HelperDiagnosticPlatform;
  browserFamily: HelperDiagnosticBrowserFamily;
}

/**
 * Formats a bounded report from an explicit allowlist. Do not spread extension
 * state into this object: most state contains data that must never enter helper
 * activation diagnostics.
 */
export function formatHelperDiagnosticReport(
  input: HelperDiagnosticReportInput,
): string {
  const { state } = input;
  const failure = state.helperFailure;
  const diagnostic = failure ?? state.helperDiagnostic;
  const fields: Array<[string, string | number | boolean]> = [
    ["schemaVersion", HELPER_DIAGNOSTIC_SCHEMA_VERSION],
    ["extensionVersion", safeVersion(input.extensionVersion)],
    ["helperVersion", safeVersion(state.hostVersion ?? "unknown")],
    ["releaseVersion", safeVersion(input.releaseVersion)],
    ["os", safePlatformValue(input.platform.os)],
    ["architecture", safePlatformValue(input.platform.arch)],
    ["browserFamily", input.browserFamily],
    ["helperConnected", state.hostConnected],
    ["helperInitialized", state.initialized],
    ["reconnecting", state.reconnecting],
    ["failureKind", failure?.kind ?? "none"],
    [
      "diagnosticCode",
      safeDiagnosticCode(diagnostic?.diagnosticCode ?? "none"),
    ],
    [
      "diagnosticMessage",
      sanitizeDiagnosticMessage(diagnostic?.diagnosticMessage) ?? "none",
    ],
    ["supportsNetcheck", state.supportsNetcheck],
    ["supportsPingPeer", state.supportsPingPeer],
    ["supportsLogin", state.supportsLogin],
    ["supportsCustomControlURL", state.supportsCustomControlURL],
    ["repairRegistrationAvailable", state.repairRegistrationAvailable],
  ];

  const report = [
    "Tailchrome helper diagnostic report",
    ...fields.map(([key, value]) => `${key}: ${String(value)}`),
    "",
  ].join("\n");

  return report.slice(0, MAX_HELPER_DIAGNOSTIC_REPORT_LENGTH);
}

function safeVersion(value: string): string {
  return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
    ? value
    : "unknown";
}

function safePlatformValue(value: string): string {
  return /^[A-Za-z0-9_-]{1,32}$/.test(value) ? value : "unknown";
}

function safeDiagnosticCode(value: string): string {
  return /^[a-z0-9-]{1,96}$/.test(value) ? value : "unknown";
}
