import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createRateLimiter, resetRateLimits } from '../lib/security/rate-limiter.js';
import express, { Request, Response } from 'express';

describe('Production Hardening & Security Verification', () => {
  beforeEach(() => {
    resetRateLimits();
  });

  describe('1. HTTP Security Headers (OWASP Standards)', () => {
    it('should include nosniff, DENY, and Referrer-Policy headers on all responses', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);

      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-xss-protection']).toBe('0');
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(res.headers['permissions-policy']).toContain('camera=()');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
    });

    it('should include security headers even on 404 and API endpoints', async () => {
      const res = await request(app).get('/api/unknown-endpoint');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
    });
  });

  describe('2. Rate Limiting Enforcement & Headers', () => {
    it('should attach standard rate limit headers and throttle when limit is reached', async () => {
      const testApp = express();
      const limiter = createRateLimiter({
        windowMs: 5000,
        max: 3,
        skipInTest: false,
        keyPrefix: 'test_rl',
      });

      testApp.use(limiter);
      testApp.get('/test', (_req: Request, res: Response) => {
        res.json({ ok: true });
      });

      // Request 1: Allowed
      const res1 = await request(testApp).get('/test');
      expect(res1.status).toBe(200);
      expect(res1.headers['x-ratelimit-limit']).toBe('3');
      expect(res1.headers['x-ratelimit-remaining']).toBe('2');

      // Request 2: Allowed
      const res2 = await request(testApp).get('/test');
      expect(res2.status).toBe(200);
      expect(res2.headers['x-ratelimit-remaining']).toBe('1');

      // Request 3: Allowed (last allowed)
      const res3 = await request(testApp).get('/test');
      expect(res3.status).toBe(200);
      expect(res3.headers['x-ratelimit-remaining']).toBe('0');

      // Request 4: Throttled (429)
      const res4 = await request(testApp).get('/test');
      expect(res4.status).toBe(429);
      expect(res4.headers['retry-after']).toBeDefined();
      expect(res4.body.error).toContain('Too many requests');
      expect(res4.body.retryAfterSeconds).toBeGreaterThan(0);
    });
  });

  describe('3. Server-Side Pagination Contracts', () => {
    it('GET /api/resume-analyses returns structured pagination metadata', async () => {
      const res = await request(app).get('/api/resume-analyses?page=1&limit=5');
      expect(res.status).toBe(200);
      expect(res.body.analyses).toBeDefined();
      expect(Array.isArray(res.body.analyses)).toBe(true);

      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.page).toBe(1);
      expect(res.body.pagination.limit).toBe(5);
      expect(typeof res.body.pagination.totalCount).toBe('number');
      expect(typeof res.body.pagination.totalPages).toBe('number');
      expect(typeof res.body.pagination.hasMore).toBe('boolean');
    });

    it('GET /api/questions preserves server-side pagination with custom limits', async () => {
      const res = await request(app).get('/api/questions?page=1&limit=5');
      expect(res.status).toBe(200);
      expect(res.body.questions).toBeDefined();
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.page).toBe(1);
      expect(res.body.pagination.limit).toBe(5);
    });
  });
});
