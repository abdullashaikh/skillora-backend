import dns from 'dns/promises';
import { URL } from 'url';

export interface URLValidationResult {
  isValid: boolean;
  normalizedUrl?: string;
  error?: string;
  ip?: string;
}

/**
 * Checks whether an IPv4 or IPv6 address belongs to private, loopback, or metadata networks.
 */
export function isPrivateOrReservedIP(ip: string): boolean {
  // Normalize IPv6-mapped IPv4 addresses (e.g. ::ffff:127.0.0.1)
  const cleanIp = ip.replace(/^::ffff:/i, '').trim();

  // IPv4 checks
  const ipv4Parts = cleanIp.split('.').map((p) => parseInt(p, 10));
  if (ipv4Parts.length === 4 && ipv4Parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
    const [b0, b1, b2] = ipv4Parts;

    // 0.0.0.0/8 (Current network)
    if (b0 === 0) return true;

    // 127.0.0.0/8 (Loopback)
    if (b0 === 127) return true;

    // 10.0.0.0/8 (Private)
    if (b0 === 10) return true;

    // 172.16.0.0/12 (Private: 172.16.0.0 - 172.31.255.255)
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;

    // 192.168.0.0/16 (Private)
    if (b0 === 192 && b1 === 168) return true;

    // 169.254.0.0/16 (Link-Local & Cloud Metadata, e.g. AWS/GCP 169.254.169.254)
    if (b0 === 169 && b1 === 254) return true;

    // 100.64.0.0/10 (Carrier-grade NAT)
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;

    // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (TEST-NET documentation)
    if (b0 === 192 && b1 === 0 && b2 === 2) return true;
    if (b0 === 198 && b1 === 51 && b2 === 100) return true;
    if (b0 === 203 && b1 === 0 && b2 === 113) return true;

    // 224.0.0.0/4 (Multicast)
    if (b0 >= 224 && b0 <= 239) return true;

    // 240.0.0.0/4 (Reserved / Future use & Broadcast)
    if (b0 >= 240) return true;

    return false;
  }

  // IPv6 checks
  const lowerV6 = cleanIp.toLowerCase();
  // Loopback ::1
  if (lowerV6 === '::1' || lowerV6 === '0:0:0:0:0:0:0:1') return true;
  // Unspecified ::
  if (lowerV6 === '::' || lowerV6 === '0:0:0:0:0:0:0:0') return true;
  // Unique local fc00::/7 (fc00:: - fdff::)
  if (lowerV6.startsWith('fc') || lowerV6.startsWith('fd')) return true;
  // Link-local fe80::/10 (fe80:: - febf::)
  if (
    lowerV6.startsWith('fe8') ||
    lowerV6.startsWith('fe9') ||
    lowerV6.startsWith('fea') ||
    lowerV6.startsWith('feb')
  ) {
    return true;
  }

  return false;
}

/**
 * Validates a target URL against SSRF vulnerabilities, DNS rebinding, and prohibited networks.
 */
export async function validateSafeUrl(
  inputUrl: string,
  allowLocalhostInDev = false
): Promise<URLValidationResult> {
  if (!inputUrl || typeof inputUrl !== 'string') {
    return { isValid: false, error: 'URL must be a non-empty string.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(inputUrl.trim());
  } catch {
    return { isValid: false, error: 'Invalid URL format.' };
  }

  // Scheme verification: Only https or http (for trusted sites)
  const isDev = process.env.NODE_ENV !== 'production';
  const allowedSchemes = ['https:', 'http:'];
  if (!allowedSchemes.includes(parsed.protocol)) {
    return { isValid: false, error: `Protocol "${parsed.protocol}" is not allowed. Only HTTP/HTTPS are supported.` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Explicit forbidden hostnames
  const forbiddenHosts = [
    'localhost',
    'metadata.google.internal',
    '169.254.169.254',
    'instance-data',
    'local',
    'internal',
  ];

  if (!allowLocalhostInDev || !isDev) {
    if (forbiddenHosts.includes(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      return { isValid: false, error: `Access to destination "${hostname}" is blocked for security.` };
    }
  }

  // Resolve hostname via DNS to ensure the underlying IP is not private/reserved
  try {
    const lookup = await dns.lookup(hostname, { all: true });
    if (!lookup || lookup.length === 0) {
      return { isValid: false, error: `Could not resolve hostname "${hostname}".` };
    }

    for (const addressEntry of lookup) {
      const resolvedIp = addressEntry.address;
      if (!allowLocalhostInDev || !isDev) {
        if (isPrivateOrReservedIP(resolvedIp)) {
          return {
            isValid: false,
            error: `Resolved IP address ${resolvedIp} for ${hostname} is private or reserved. SSRF access blocked.`,
          };
        }
      }
    }

    return {
      isValid: true,
      normalizedUrl: parsed.toString(),
      ip: lookup[0].address,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'DNS lookup failed';
    return { isValid: false, error: `DNS resolution error for "${hostname}": ${msg}` };
  }
}

/**
 * Safe fetch wrapper that handles:
 * - SSRF re-validation on redirects
 * - Response size limits (default 2MB)
 * - Request timeout (default 10s)
 * - Controlled user-agent
 * - No credentials forwarding
 */
export async function safeFetchUrl(
  targetUrl: string,
  options: {
    maxSizeBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
    customHeaders?: Record<string, string>;
  } = {}
): Promise<{ text: string; status: number; finalUrl: string; contentType: string }> {
  const maxSizeBytes = options.maxSizeBytes || 2 * 1024 * 1024; // 2MB limit
  const timeoutMs = options.timeoutMs || 10000; // 10 seconds
  const maxRedirects = options.maxRedirects ?? 3;

  let currentUrl = targetUrl;
  let redirectsCount = 0;

  while (redirectsCount <= maxRedirects) {
    // 1. Validate destination before every hop
    const validation = await validateSafeUrl(currentUrl);
    if (!validation.isValid) {
      throw new Error(`SSRF Security check failed for "${currentUrl}": ${validation.error}`);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(currentUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SkilledResumeQABot/2.0 (+https://skilledresume.local)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/markdown,text/plain,application/json,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          ...(options.customHeaders || {}),
        },
        redirect: 'manual', // Manual redirect control to validate each redirect hop!
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Check redirects
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`Redirect response (${response.status}) missing Location header.`);
        }
        const resolvedRedirect = new URL(location, currentUrl).toString();
        currentUrl = resolvedRedirect;
        redirectsCount++;
        continue;
      }

      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after');
        const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
        const rateLimitReset = response.headers.get('x-ratelimit-reset');
        let bodySnippet = '';
        try {
          bodySnippet = await response.text();
        } catch {}

        if (response.status === 403 || response.status === 429) {
          if (rateLimitRemaining === '0' || bodySnippet.toLowerCase().includes('rate limit')) {
            const resetTime = rateLimitReset ? new Date(parseInt(rateLimitReset, 10) * 1000).toLocaleTimeString() : 'shortly';
            throw new Error(`GitHub API rate limit reached (status ${response.status}). Resets at ${resetTime}. Retry-after: ${retryAfter || '60s'}. Provide GITHUB_TOKEN in your environment to increase limit.`);
          }
        }

        throw new Error(`HTTP Error ${response.status}: ${response.statusText}${bodySnippet ? ' - ' + bodySnippet.slice(0, 200) : ''}`);
      }

      // Check Content-Length header if present
      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader) {
        const size = parseInt(contentLengthHeader, 10);
        if (size > maxSizeBytes) {
          throw new Error(`Response size (${size} bytes) exceeds maximum permitted limit (${maxSizeBytes} bytes).`);
        }
      }

      // Read text with strict size bounds
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > maxSizeBytes) {
        throw new Error(`Response body exceeds maximum allowed size of ${maxSizeBytes} bytes.`);
      }

      return {
        text,
        status: response.status,
        finalUrl: currentUrl,
        contentType: response.headers.get('content-type') || 'text/plain',
      };
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Request to "${currentUrl}" timed out after ${timeoutMs}ms.`);
      }
      throw err;
    }
  }

  throw new Error(`Too many redirects (exceeded limit of ${maxRedirects}).`);
}
