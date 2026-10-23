import { Request, Response, NextFunction } from 'express';

/**
 * Standard HTTP Security Headers Middleware.
 * Applies OWASP-recommended security headers to all incoming API requests.
 */
export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Prevent MIME-sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent clickjacking / framing
  res.setHeader('X-Frame-Options', 'DENY');

  // Disable obsolete and buggy XSS auditor in modern browsers
  res.setHeader('X-XSS-Protection', '0');

  // Referrer Policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions Policy: disable sensitive device APIs
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');

  // Cross-Origin Opener Policy: allow OAuth popups while isolating window context
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');

  // Strict Transport Security (HSTS) in production or over HTTPS
  if (process.env.NODE_ENV === 'production' || req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  next();
}
