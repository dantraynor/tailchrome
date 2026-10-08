import { describe, expect, it } from "vitest";
import {
  parseIPv6Address,
  parseIPv6CIDR,
  matchesIPv6Subnet,
  ipv6SubnetPACSource,
} from "./ipv6-subnets";

describe("IPv6 subnet routing", () => {
  it("parses compressed, expanded, uppercase, bracketed and embedded IPv4 literals", () => {
    const words = [0xfd00, 1, 2, 0, 0, 0, 0, 5];
    for (const literal of ["fd00:1:2::5", "[FD00:1:2::5]", "fd00:0001:0002:0:0:0:0:0005"]) {
      expect(parseIPv6Address(literal)).toEqual(words);
    }
    expect(parseIPv6Address("2001:db8::192.0.2.1")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0xc000, 0x0201]);
    expect(parseIPv6Address("::")).toEqual(Array(8).fill(0));
  });

  it.each([
    "", "wiki", "192.0.2.1", "fd00::1::2", "fd00:::1", "fd00:1:2:3:4:5:6",
    "fd00:1:2:3:4:5:6:7:8", "fd00:1:2:3:4:5:6::7", "fd00::12345", "fd00::g",
    "[fd00::1", "fd00::1]", "[[fd00::1]]", "fd00::1%eth0", "[fd00::1%eth0]",
    " fd00::1", "fd00::1 ", "fd00::1\n", "fd00::1.", ":fd00:1:2:3:4:5:6:7",
    "2001:db8::192.00.2.1", "2001:db8::256.0.2.1", "2001:db8::192.0.2",
    "2001:db8::192.0.2.1:3",
  ])("rejects malformed literal %j in runtime and PAC matching", (literal) => {
    const subnets = [parseIPv6CIDR("fd00::/8")!];
    expect(parseIPv6Address(literal)).toBeNull();
    expect(matchesIPv6Subnet(literal, subnets)).toBe(false);
    const pacMatch = new Function("host", `${ipv6SubnetPACSource(subnets)}; return tailchromeIPv6.matches(host, tailchromeIPv6Subnets);`);
    expect(pacMatch(literal)).toBe(false);
  });

  it.each([
    "fd00::", "fd00::/", "fd00::/129", "fd00::/-1", "fd00::/1.5", "fd00::/64junk",
    "fd00::/064", "fd00::/0x40", "fd00::/64\n", "[fd00::]/64", "fd00::%eth0/64",
    "fd00::/64/32", "fd00::g/64", "fd00::/Infinity", "fd00::/NaN",
    'fd00::/64; return "DIRECT";', "fd00::/ 64",
  ])("rejects malformed CIDR %j", cidr => {
    expect(parseIPv6CIDR(cidr)).toBeNull();
  });

  it.each([
    "::/0", "2001:db8::/0", "::/128", "::1/128", "::2/126", "8000::/1",
    "fe80::/10", "febf:ffff::/32", "fec0::/9", "ff00::/8", "ff02::/16",
    "::ffff:192.0.2.0/120", "::ffff:c000:200/120",
  ])("honors the native helper's forbidden route overlaps: %s", cidr => {
    expect(parseIPv6CIDR(cidr)).toBeNull();
  });

  it.each([
    ["fd00:1:2::9/64", "[FD00:1:2::ffff]", "fd00:1:3::1"],
    ["fd00:1:2:3:4:5:afff:ffff/100", "fd00:1:2:3:4:5:a000:1", "fd00:1:2:3:4:5:b000:0"],
    ["fd00:1:2:3:4:5:8800::/101", "fd00:1:2:3:4:5:8fff:ffff", "fd00:1:2:3:4:5:9000:0"],
    ["fd00::9/127", "fd00::8", "fd00::a"],
    ["fd00::9/128", "fd00::9", "fd00::8"],
    ["2000::/3", "2001:db8::1", "4000::1"],
    ["fec0::/10", "fec0::1", "fe80::1"],
  ])("matches prefix boundaries for %s in runtime and PAC", (cidr, inside, outside) => {
    const subnets = [parseIPv6CIDR(cidr)!];
    expect(subnets[0]).not.toBeNull();
    const pacMatch = new Function("host", `${ipv6SubnetPACSource(subnets)}; return tailchromeIPv6.matches(host, tailchromeIPv6Subnets);`);
    for (const [host, expected] of [[inside, true], [outside, false]] as const) {
      expect(matchesIPv6Subnet(host, subnets)).toBe(expected);
      expect(pacMatch(host)).toBe(expected);
    }
  });

  it("never matches IPv4-mapped destinations through an IPv6 route", () => {
    const subnets = [parseIPv6CIDR("::fffe:0:0/95")!];
    expect(matchesIPv6Subnet("::fffe:c000:201", subnets)).toBe(true);
    for (const host of ["::ffff:192.0.2.1", "::ffff:c000:201"]) {
      expect(matchesIPv6Subnet(host, subnets)).toBe(false);
    }
  });
});
