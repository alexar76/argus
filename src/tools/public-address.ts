import { isIP } from 'node:net';

/** Refuse destinations outside public unicast, including IPv4 carried inside IPv6. */
export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  if (family !== 6 || address.includes('%')) return true;
  const words = ipv6Words(address);
  const first = words[0]!;
  const embeddedIPv4 = (offset: number) => {
    const high = words[offset]!, low = words[offset + 1]!;
    return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  };
  // URL and DNS libraries commonly canonicalize ::ffff:127.0.0.1 to ::ffff:7f00:1.
  // Compare numeric groups so expanded, compressed and dotted spellings agree.
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    return isNonPublicAddress(embeddedIPv4(6));
  }
  if (first === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every(word => word === 0)) {
    return isNonPublicAddress(embeddedIPv4(6)); // well-known NAT64 /96
  }
  if (first === 0x2002 && isNonPublicAddress(embeddedIPv4(1))) return true; // 6to4
  // Public IPv6 unicast is 2000::/3. Everything else includes local/compatible,
  // unspecified, link-local, multicast and local-use translation addresses.
  if ((first & 0xe000) !== 0x2000) return true;
  if (first === 0x2001) {
    const second = words[1]!;
    if (second === 0 || second === 0xdb8 ||
        (second === 2 && words[2] === 0) ||
        (second & 0xfff0) === 0x10 || (second & 0xfff0) === 0x20) return true;
  }
  return first === 0x3fff && (words[1]! & 0xf000) === 0; // documentation /20
}

/** Called only after node:net has validated the address. */
function ipv6Words(address: string): number[] {
  let hex = address.toLowerCase();
  if (hex.includes('.')) {
    const end = hex.lastIndexOf(':');
    const octets = hex.slice(end + 1).split('.').map(Number);
    hex = `${hex.slice(0, end + 1)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const [head, tail] = hex.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return groups.map(word => Number.parseInt(word, 16));
}
