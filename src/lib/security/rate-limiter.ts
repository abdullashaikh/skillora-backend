import { Request, Response, NextFunction } from 'express';

interface RateLimitRecord {
  count: number;
  resetTimeMs: number;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
  statusCode?: number;
  keyPrefix?: string;
  skipInTest?: boolean;
  keyGenerator?: (req: Request) => string;
}

const memoryStore = new Map<string, RateLimitRecord>();

// Periodic garbage collection every 60 seconds
const gcInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, record] of memoryStore.entries()) {
    if (record.resetTimeMs <= now) {
      memoryStore.delete(key);
    }
  }
}, 60000);

// Prevent GC timer from holding open the Node process in test runs
if (gcInterval.unref) {
  gcInterval.unref();
}

/**
 * Resets all stored rate limit records (useful for test isolation).
 */
export function resetRateLimits(): void {
  memoryStore.clear();
}

/**
 * Default key generator using client IP or forwarded IP, with session fallback.
 */
function defaultKeyGenerator(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  let ip = '';
  if (typeof forwarded === 'string') {
    ip = forwarded.split(',')[0].trim();
  } else if (Array.isArray(forwarded) && forwarded.length > 0) {
    ip = forwarded[0].trim();
  } else {
    ip = req.socket?.remoteAddress || req.ip || '127.0.0.1';
  }

  // Include user ID or guest session if authenticated to avoid penalizing entire NAT networks
  const userIdentifier = req.auth?.user?.id || req.auth?.guestSessionId || '';
  return userIdentifier ? `${ip}:${userIdentifier}` : ip;
}

/**
 * Factory for creating express rate limiting middleware.
 */
export function createRateLimiter(options: RateLimitOptions) {
  const {
    windowMs,
    max,
    message = 'Too many requests. Please slow down and try again later.',
    statusCode = 429,
    keyPrefix = 'rl',
    skipInTest = true,
    keyGenerator = defaultKeyGenerator,
  } = options;

  return function rateLimiterMiddleware(req: Request, res: Response, next: NextFunction): void {
    // If running in test mode and skipInTest is true, allow bypassing unless header is present
    if (process.env.NODE_ENV === 'test' && skipInTest && !req.headers['x-test-enforce-ratelimit']) {
      return next();
    }

    const key = `${keyPrefix}:${keyGenerator(req)}`;
    const now = Date.now();
    const record = memoryStore.get(key);

    if (!record || record.resetTimeMs <= now) {
      // First hit in this window
      const newRecord: RateLimitRecord = {
        count: 1,
        resetTimeMs: now + windowMs,
      };
      memoryStore.set(key, newRecord);

      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', max - 1);
      res.setHeader('X-RateLimit-Reset', Math.ceil(newRecord.resetTimeMs / 1000));
      return next();
    }

    record.count += 1;
    const remaining = Math.max(0, max - record.count);
    const retryAfterSec = Math.ceil((record.resetTimeMs - now) / 1000);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(record.resetTimeMs / 1000));

    if (record.count > max) {
      res.setHeader('Retry-After', retryAfterSec);
      res.status(statusCode).json({
        error: message,
        retryAfterSeconds: retryAfterSec,
      });
      return;
    }

    return next();
  };
}

/**
 * Rate Limiter for Authentication endpoints (login, register, reset password, etc.)
 * Limits to 15 requests per 1 minute per IP/Session.
 */
export const authRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 15,
  keyPrefix: 'auth',
  message: 'Too many authentication attempts. Please wait 1 minute before trying again.',
});

/**
 * Rate Limiter for AI Resume Analysis uploads.
 * Limits to 10 uploads per 10 minutes per IP/Session to prevent resource exhaustion.
 */
export const resumeUploadRateLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyPrefix: 'resume_upload',
  message: 'Upload frequency limit reached. Please wait a few minutes before submitting another resume.',
});

/**
 * General API Rate Limiter.
 * Limits to 200 requests per 1 minute per client.
 */
export const generalApiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 200,
  keyPrefix: 'gen_api',
  message: 'API rate limit exceeded. Please throttle your requests.',
});
