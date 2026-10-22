import { describe, it, expect } from 'vitest';
import { isPrivateOrReservedIP, validateSafeUrl } from '../lib/qa/url-validator.js';

describe('SSRF Protection & Safe URL Validation', () => {
  it('should detect private and reserved IPv4 addresses', () => {
    // Loopback
    expect(isPrivateOrReservedIP('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIP('127.0.1.5')).toBe(true);

    // Private Class A (10.0.0.0/8)
    expect(isPrivateOrReservedIP('10.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIP('10.254.1.20')).toBe(true);

    // Private Class B (172.16.0.0/12)
    expect(isPrivateOrReservedIP('172.16.0.1')).toBe(true);
    expect(isPrivateOrReservedIP('172.31.255.254')).toBe(true);
    expect(isPrivateOrReservedIP('172.32.0.1')).toBe(false); // Public

    // Private Class C (192.168.0.0/16)
    expect(isPrivateOrReservedIP('192.168.1.1')).toBe(true);
    expect(isPrivateOrReservedIP('192.168.100.50')).toBe(true);

    // Link-Local / Cloud Metadata (169.254.0.0/16)
    expect(isPrivateOrReservedIP('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedIP('169.254.1.1')).toBe(true);

    // Current network (0.0.0.0/8)
    expect(isPrivateOrReservedIP('0.0.0.0')).toBe(true);

    // Public IPs
    expect(isPrivateOrReservedIP('8.8.8.8')).toBe(false);
    expect(isPrivateOrReservedIP('1.1.1.1')).toBe(false);
    expect(isPrivateOrReservedIP('140.82.112.4')).toBe(false); // GitHub
  });

  it('should detect private and reserved IPv6 addresses', () => {
    expect(isPrivateOrReservedIP('::1')).toBe(true);
    expect(isPrivateOrReservedIP('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isPrivateOrReservedIP('fc00::1')).toBe(true);
    expect(isPrivateOrReservedIP('fd12:3456:789a::1')).toBe(true);
    expect(isPrivateOrReservedIP('fe80::1')).toBe(true);
  });

  it('should reject non-HTTP/HTTPS schemes', async () => {
    const ftp = await validateSafeUrl('ftp://example.com/file.txt');
    expect(ftp.isValid).toBe(false);
    expect(ftp.error).toContain('Only HTTP/HTTPS are supported');

    const file = await validateSafeUrl('file:///etc/passwd');
    expect(file.isValid).toBe(false);

    const gopher = await validateSafeUrl('gopher://example.com');
    expect(gopher.isValid).toBe(false);
  });

  it('should reject prohibited hostnames like localhost and cloud metadata', async () => {
    const localhost = await validateSafeUrl('http://localhost:5000/api');
    expect(localhost.isValid).toBe(false);
    expect(localhost.error).toContain('blocked');

    const metadata = await validateSafeUrl('http://metadata.google.internal/computeMetadata/v1/');
    expect(metadata.isValid).toBe(false);

    const ipMeta = await validateSafeUrl('http://169.254.169.254/latest/meta-data/');
    expect(ipMeta.isValid).toBe(false);
  });

  it('should accept valid public domains', async () => {
    const result = await validateSafeUrl('https://github.com/trekhleb/javascript-algorithms');
    expect(result.isValid).toBe(true);
    expect(result.normalizedUrl).toContain('https://github.com');
  });
});
