import { describe, expect, it } from "vitest";
import { baseState, makePeer } from "./__test__/fixtures";
import {
  formatHelperDiagnosticReport,
  MAX_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_HELPER_DIAGNOSTIC_REPORT_LENGTH,
  sanitizeDiagnosticMessage,
} from "./helper-diagnostics";

describe("sanitizeDiagnosticMessage", () => {
  it("redacts private locations and URLs before diagnostic state is retained", () => {
    expect(
      sanitizeDiagnosticMessage(
        "failed at /Users/alice/Library/Tailchrome; see https://auth.example.test/login",
      ),
    ).toBe(
      "failed at [redacted-home]/Library/Tailchrome; see [redacted-url]",
    );
  });

  it("bounds retained native detail", () => {
    expect(sanitizeDiagnosticMessage("x".repeat(20_000))).toHaveLength(
      MAX_DIAGNOSTIC_MESSAGE_LENGTH,
    );
  });

  it("does not serialize arbitrary structured values into diagnostics", () => {
    expect(
      sanitizeDiagnosticMessage({
        profileID: "private-profile",
        authorization: "Bearer private-token",
      }),
    ).toBeNull();
  });

  it("redacts labeled identity and current-user registry values", () => {
    const sanitized = sanitizeDiagnosticMessage(
      "tailnet=secret-tailnet, profileID=private-profile; peer=alice; userName=Daniel Traynor; HKCU\\Software\\Tailchrome\\Alice",
    );

    expect(sanitized).toContain("tailnet=[redacted-identity]");
    expect(sanitized).toContain("profileID=[redacted-identity]");
    expect(sanitized).toContain("peer=[redacted-identity]");
    expect(sanitized).toContain("userName=[redacted-identity]");
    expect(sanitized).toContain("[redacted-registry]");
    for (const excluded of [
      "secret-tailnet",
      "private-profile",
      "alice",
      "Daniel",
      "Traynor",
      "HKCU",
      "Tailchrome\\Alice",
    ]) {
      expect(sanitized).not.toContain(excluded);
    }
  });

  it("redacts quoted, Tailscale, and control-character credentials", () => {
    const sanitized = sanitizeDiagnosticMessage(
      'token="top secret phrase"; Bearer "second secret"; password="escaped \\"third secret\\" phrase"; authorization="unterminated fourth secret; auth key tskey-auth-k1234567890; bad\u0081control',
    );

    expect(sanitized).toContain("token=[redacted-credential]");
    expect(sanitized).toContain("Bearer [redacted-credential]");
    expect(sanitized).toContain("[redacted-credential]");
    for (const excluded of [
      "top secret phrase",
      "second secret",
      "third secret",
      "fourth secret",
      "tskey-auth-k1234567890",
      "\u0081",
    ]) {
      expect(sanitized).not.toContain(excluded);
    }
  });

  it("redacts common structured authentication field names", () => {
    const sanitized = sanitizeDiagnosticMessage(
      [
        "access_token=access-value",
        "refresh_token=refresh-value",
        "client_secret=client-value",
        "api_key=api-value",
        "session_id=session-value",
        "session_cookie=cookie-value",
        "sessionCookie=camel-cookie-value",
        "auth_token=auth-value",
        "oauth_token=oauth-value",
        "csrf_token=csrf-value",
        "Cookie=session_cookie_value",
        "private_key=private-value",
      ].join("; "),
    );

    for (const label of [
      "access_token",
      "refresh_token",
      "client_secret",
      "api_key",
      "session_id",
      "session_cookie",
      "sessionCookie",
      "auth_token",
      "oauth_token",
      "csrf_token",
      "Cookie",
      "private_key",
    ]) {
      expect(sanitized).toContain(`${label}=[redacted-credential]`);
    }
    for (const excluded of [
      "access-value",
      "refresh-value",
      "client-value",
      "api-value",
      "session-value",
      "cookie-value",
      "camel-cookie-value",
      "auth-value",
      "oauth-value",
      "csrf-value",
      "session_cookie_value",
      "private-value",
    ]) {
      expect(sanitized).not.toContain(excluded);
    }
  });
});

describe("formatHelperDiagnosticReport", () => {
  it("serializes only the helper-activation allowlist", () => {
    const state = baseState({
      tailnet: "secret-tailnet.ts.net",
      browseToURL: "https://login.example.test/private",
      currentProfile: { id: "private-profile-id", name: "Alice" },
      peers: [
        makePeer({
          hostname: "private-peer",
          tailscaleIPs: ["100.64.0.8"],
          userName: "Alice",
          userLoginName: "alice@example.test",
        }),
      ],
      helperFailure: {
        kind: "helper-start-failed",
        diagnosticCode: "native-host-start-failed",
        diagnosticMessage: sanitizeDiagnosticMessage(
          "fixture launch failed at /home/alice/.config; token=super-secret; https://auth.example.test",
        ),
      },
      hostVersion: "0.1.11",
      repairRegistrationAvailable: true,
    });

    const report = formatHelperDiagnosticReport({
      state,
      extensionVersion: "0.1.12",
      releaseVersion: "0.1.12",
      platform: { os: "linux", arch: "arm64" },
      browserFamily: "firefox",
    });

    expect(report).toContain("schemaVersion: 1");
    expect(report).toContain("helperVersion: 0.1.11");
    expect(report).toContain("failureKind: helper-start-failed");
    expect(report).toContain("fixture launch failed");
    expect(report).toContain("[redacted-home]");
    expect(report).toContain("[redacted-credential]");
    expect(report).toContain("[redacted-url]");
    expect(report).not.toContain("secret-tailnet");
    expect(report).not.toContain("login.example");
    expect(report).not.toContain("private-profile");
    expect(report).not.toContain("private-peer");
    expect(report).not.toContain("100.64.0.8");
    expect(report).not.toContain("Alice");
    expect(report).not.toContain("super-secret");
  });

  it("redacts labeled identities even when they arrive in free-text detail", () => {
    const report = formatHelperDiagnosticReport({
      state: baseState({
        helperDiagnostic: {
          diagnosticCode: "native-start-detail",
          diagnosticMessage:
            "tailnet=secret, profileID=private; peer=alice; userName=Daniel Traynor; HKCU\\Software\\Private",
        },
      }),
      extensionVersion: "0.1.12",
      releaseVersion: "0.1.12",
      platform: { os: "win", arch: "x86-64" },
      browserFamily: "chromium",
    });

    for (const excluded of [
      "tailnet=secret",
      "profileID=private",
      "peer=alice",
      "Daniel",
      "Traynor",
      "HKCU",
      "Software\\Private",
    ]) {
      expect(report).not.toContain(excluded);
    }
  });

  it("caps the complete report", () => {
    const report = formatHelperDiagnosticReport({
      state: baseState({
        helperDiagnostic: {
          diagnosticCode: "native-message-invalid",
          diagnosticMessage: "x".repeat(20_000),
        },
      }),
      extensionVersion: "0.1.12",
      releaseVersion: "0.1.12",
      platform: { os: "linux", arch: "amd64" },
      browserFamily: "chromium",
    });

    expect(report.length).toBeLessThanOrEqual(
      MAX_HELPER_DIAGNOSTIC_REPORT_LENGTH,
    );
  });

  it("sanitizes diagnostic state again at the report boundary", () => {
    const report = formatHelperDiagnosticReport({
      state: baseState({
        helperDiagnostic: {
          diagnosticCode: "unsafe-seed",
          diagnosticMessage:
            "raw /Users/alice/private token=secret https://auth.example.test",
        },
      }),
      extensionVersion: "0.1.12",
      releaseVersion: "0.1.12",
      platform: { os: "mac", arch: "arm64" },
      browserFamily: "chromium",
    });

    expect(report).toContain(
      "diagnosticMessage: raw [redacted-home]/private token=[redacted-credential] [redacted-url]",
    );
    expect(report).not.toContain("/Users/alice");
    expect(report).not.toContain("token=secret");
    expect(report).not.toContain("auth.example");
  });
});
