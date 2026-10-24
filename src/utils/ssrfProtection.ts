import * as dns from 'dns';

/**
 * SSRF protection utilities for Trapper.
 *
 * Blocks requests to private IP ranges, loopback, link-local, and cloud
 * metadata endpoints to prevent Server-Side Request Forgery attacks.
 */

// Private and reserved IP ranges to block (IPv4 only for range checking)
const BLOCKED_RANGES: [string, number][] = [
  // Loopback
  ['127.0.0.0', 8],
  // Private ranges
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  // Link-local
  ['169.254.0.0', 16],
  // Additional reserved
  ['0.0.0.0', 8],
  ['100.64.0.0', 10], // Shared address space
  ['224.0.0.0', 4],   // Multicast
  ['240.0.0.0', 4],   // Reserved
];

// Blocked IPv6 addresses (exact match, since range checking is complex)
const BLOCKED_IPV6_ADDRESSES = new Set([
  '::1',        // IPv6 loopback
  'fe80::',     // IPv6 link-local prefix
  'fd00::',     // IPv6 unique local
  'fc00::',     // IPv6 unique local
]);

// Cloud metadata endpoints to block
const BLOCKED_HOSTS = new Set([
  'metadata.google.internal',
  '169.254.169.254',
  'instance-data.p.rackspacecloud.com',
  'metadata.service.consul',
  'localhost',
]);

function ipToNumber(ip: string): bigint | null {
  // Handle IPv4 only
  const parts = ip.split('.');
  if (parts.length === 4) {
    try {
      let result = 0n;
      for (const part of parts) {
        result = (result << 8n) | BigInt(parseInt(part, 10));
      }
      return result;
    } catch {
      return null;
    }
  }
  return null;
}

function isIpInRange(ip: string, networkStart: string, prefixLen: number): boolean {
  const ipNum = ipToNumber(ip);
  const netNum = ipToNumber(networkStart);
  if (ipNum === null || netNum === null) return false;

  const mask = (0xffffffffn << BigInt(32 - prefixLen)) & 0xffffffffn;
  return (ipNum & mask) === (netNum & mask);
}

/**
 * Check if an IP address is IPv6.
 */
function isIPv6(ip: string): boolean {
  return ip.includes(':');
}

/**
 * Check if a resolved IP address is in a blocked range.
 * Handles both IPv4 and IPv6.
 */
function isBlockedIp(ip: string): boolean {
  // Strip brackets from IPv6 addresses (e.g., [::1] -> ::1)
  const cleanIp = ip.replace(/^\[|\]$/g, '');

  // Check IPv6 addresses
  if (isIPv6(cleanIp)) {
    // Exact match for known blocked IPv6 addresses
    if (cleanIp === '::1') {
      return true;
    }
    // Check for link-local prefix (fe80::/10)
    if (cleanIp.startsWith('fe80:') || cleanIp.startsWith('FE80:')) {
      return true;
    }
    // Check for unique local addresses (fc00::/7)
    if (cleanIp.startsWith('fd00:') || cleanIp.startsWith('FD00:') ||
        cleanIp.startsWith('fc00:') || cleanIp.startsWith('FC00:')) {
      return true;
    }
    return false;
  }

  // Check IPv4 addresses against blocked ranges
  for (const [network, prefix] of BLOCKED_RANGES) {
    if (cleanIp === network || isIpInRange(cleanIp, network, prefix)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a string is an IP address (IPv4 or IPv6).
 */
function isIpAddress(hostname: string): boolean {
  // IPv4 check
  if (ipToNumber(hostname) !== null) {
    return true;
  }
  // IPv6 check (contains colons)
  if (hostname.includes(':')) {
    return true;
  }
  return false;
}

/**
 * Check if a URL points to a blocked (private/reserved) address.
 * Resolves DNS asynchronously to prevent DNS rebinding attacks.
 *
 * Returns true if the URL should be blocked to prevent SSRF.
 */
export async function isBlockedUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    if (!hostname) {
      return true; // No hostname — block it
    }

    // Check against blocked hostnames
    const hostnameLower = hostname.toLowerCase().replace(/\.$/, '');
    if (BLOCKED_HOSTS.has(hostnameLower)) {
      return true;
    }

    // If it's already an IP address, check it directly
    if (isIpAddress(hostname)) {
      if (isBlockedIp(hostname)) {
        return true;
      }
    }

    // Resolve DNS asynchronously to check for DNS rebinding attacks
    try {
      const addresses = await new Promise<( { address: string; family: number } )[]>(
        (resolve, reject) => {
          dns.lookup(hostname, { all: true, family: 0 }, (err, addresses) => {
            if (err) reject(err);
            else resolve(addresses);
          });
        }
      );
      for (const addr of addresses) {
        if (isBlockedIp(addr.address)) {
          return true;
        }
      }
    } catch {
      // If we can't resolve the hostname, block it for safety
      return true;
    }

    return false;
  } catch {
    // If we can't parse the URL, block it for safety
    return true;
  }
}
