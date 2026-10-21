import { describe, it, expect } from 'vitest';
import { signSessionToken, verifySessionToken } from '../lib/auth/jwt';

describe('RBAC & Session Security', () => {
  it('should sign and verify valid session tokens for users and admins', () => {
    const payload = {
      userId: 'user-uuid-1234',
      email: 'admin@skilledresume.local',
      role: 'ADMIN' as const,
    };

    const token = signSessionToken(payload);
    expect(token).toBeDefined();
    expect(typeof token).toBe('string');

    const decoded = verifySessionToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.userId).toBe(payload.userId);
    expect(decoded?.email).toBe(payload.email);
    expect(decoded?.role).toBe('ADMIN');
  });

  it('should reject tampered or corrupted tokens', () => {
    const payload = {
      userId: 'user-uuid-1234',
      email: 'user@example.com',
      role: 'USER' as const,
    };

    const token = signSessionToken(payload);
    const tampered = token.slice(0, -5) + 'xxxxx';

    const decoded = verifySessionToken(tampered);
    expect(decoded).toBeNull();
  });
});
