import assert from "node:assert/strict";
import test from "node:test";

import { pacHasExactHostRule } from "./assertions.mjs";

test("pacHasExactHostRule matches only an exact quoted host operand", () => {
  const pac = `function FindProxyForURL(url, host) {
    if (host === "outlook.office.com" || dnsDomainIs(host, ".outlook.office.com")) {
      return "DIRECT";
    }
  }`;

  assert.equal(pacHasExactHostRule(pac, "outlook.office.com"), true);
  assert.equal(pacHasExactHostRule(pac, "office.com"), false);
});

test("pacHasExactHostRule rejects lookalike domains and unrelated text", () => {
  const pac = `function FindProxyForURL(url, host) {
    // outlook.office.com
    if (host === "outlook.office.com.attacker.example") return "DIRECT";
    if (host === "prefix-outlook.office.com") return "DIRECT";
  }`;

  assert.equal(pacHasExactHostRule(pac, "outlook.office.com"), false);
});
