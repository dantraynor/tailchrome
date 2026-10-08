export interface IPv6Subnet {
  network: number[];
  prefixLength: number;
}

// This factory must have no references to module variables or imported helpers.
// PAC embeds the entire factory expression, including its local closures, so
// bundling/minification can rename locals without breaking the generated script.
function createIPv6Tools() {
  function parse(input: string): number[] | null {
    let text = input;
    if (text.charAt(0) === "[" && text.charAt(text.length - 1) === "]") {
      text = text.slice(1, -1);
    }
    if (!text || /[^0-9a-fA-F:.]/.test(text) || text.indexOf(":") === -1) return null;

    // IPv4 embedded in the last two groups is valid IPv6, but never guess an
    // octet's base or accept partial numbers as parseInt would.
    if (text.indexOf(".") !== -1) {
      const lastColon = text.lastIndexOf(":");
      const octets = text.slice(lastColon + 1).split(".");
      if (octets.length !== 4) return null;
      const values: number[] = [];
      for (let i = 0; i < 4; i++) {
        const n = Number(octets[i]);
        if (String(n) !== octets[i] || n < 0 || n > 255) return null;
        values.push(n);
      }
      text = text.slice(0, lastColon + 1) +
        (values[0]! * 256 + values[1]!).toString(16) + ":" +
        (values[2]! * 256 + values[3]!).toString(16);
    }

    const halves = text.split("::");
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const count = left.length + right.length;
    if (halves.length === 1 ? count !== 8 : count >= 8) return null;
    const words: number[] = [];
    const groups = left.concat(right);
    for (let i = 0; i < groups.length; i++) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i]!)) return null;
    }
    for (let i = 0; i < left.length; i++) words.push(parseInt(left[i]!, 16));
    if (halves.length === 2) {
      for (let i = count; i < 8; i++) words.push(0);
    }
    for (let i = 0; i < right.length; i++) words.push(parseInt(right[i]!, 16));
    return words;
  }

  function prefixMatches(a: number[], b: number[], bits: number): boolean {
    for (let i = 0; bits > 0; i++, bits -= 16) {
      const scale = Math.pow(2, 16 - Math.min(bits, 16));
      if (Math.floor(a[i]! / scale) !== Math.floor(b[i]! / scale)) return false;
    }
    return true;
  }

  function matches(host: string, subnets: IPv6Subnet[]): boolean {
    const address = parse(host);
    if (!address) return false;
    // The helper unmaps these to IPv4 before authorizing a destination.
    if (address.slice(0, 5).every(word => word === 0) && address[5] === 0xffff) return false;
    for (let i = 0; i < subnets.length; i++) {
      const subnet = subnets[i]!;
      if (prefixMatches(address, subnet.network, subnet.prefixLength)) return true;
    }
    return false;
  }

  return { parse, prefixMatches, matches };
}

const tools = createIPv6Tools();
export const parseIPv6Address = tools.parse;
export const matchesIPv6Subnet = tools.matches;

/** Strict IPv6 CIDR parsing with the native helper's safeProxyRoute exclusions. */
export function parseIPv6CIDR(cidr: string): IPv6Subnet | null {
  const parts = cidr.split("/");
  if (parts.length !== 2 || parts[0]!.includes("[") || parts[0]!.includes("]")) return null;
  const prefixLength = Number(parts[1]);
  if (!Number.isInteger(prefixLength) || String(prefixLength) !== parts[1] || prefixLength < 1 || prefixLength > 128) return null;
  const network = parseIPv6Address(parts[0]!);
  if (!network) return null;
  // Go's netip treats IPv4-mapped prefixes separately; the helper rejects them.
  if (network.slice(0, 5).every(word => word === 0) && network[5] === 0xffff) return null;
  const forbidden = [
    { network: [0, 0, 0, 0, 0, 0, 0, 0], prefixLength: 128 },
    { network: [0, 0, 0, 0, 0, 0, 0, 1], prefixLength: 128 },
    { network: [0xfe80, 0, 0, 0, 0, 0, 0, 0], prefixLength: 10 },
    { network: [0xff00, 0, 0, 0, 0, 0, 0, 0], prefixLength: 8 },
  ];
  if (forbidden.some(range => tools.prefixMatches(network, range.network, Math.min(prefixLength, range.prefixLength)))) return null;
  // Canonical numeric network words keep untrusted CIDR strings out of PAC.
  for (let i = 0; i < 8; i++) {
    const bits = Math.max(0, Math.min(16, prefixLength - i * 16));
    const scale = Math.pow(2, 16 - bits);
    network[i] = Math.floor(network[i]! / scale) * scale;
  }
  return { network, prefixLength };
}

/** Only validated numeric routes are serialized; the emitted factory has no external references. */
export function ipv6SubnetPACSource(subnets: IPv6Subnet[]): string {
  return `var tailchromeIPv6 = (${createIPv6Tools.toString()})();\nvar tailchromeIPv6Subnets = ${JSON.stringify(subnets)};`;
}
