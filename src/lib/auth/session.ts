import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { verifySessionToken, UserSessionPayload, signSessionToken } from './jwt.js';
import { prisma } from '../db.js';

export const AUTH_COOKIE_NAME = 'skilled_auth_token';
export const GUEST_COOKIE_NAME = 'skilled_guest_session';

export interface AuthContext {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: 'USER' | 'ADMIN';
    isEmailVerified: boolean;
  } | null;
  guestSessionId: string;
  isGuest: boolean;
}

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Middleware that populates req.auth with the user or guest session.
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    let guestSessionId = req.cookies?.[GUEST_COOKIE_NAME];
    if (!guestSessionId || typeof guestSessionId !== 'string' || guestSessionId.length < 16) {
      guestSessionId = crypto.randomUUID();
      res.cookie(GUEST_COOKIE_NAME, guestSessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        path: '/',
      });
    }

    // Check token from cookie or Authorization header
    let token = req.cookies?.[AUTH_COOKIE_NAME];
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      req.auth = {
        user: null,
        guestSessionId,
        isGuest: true,
      };
      return next();
    }

    const payload = verifySessionToken(token);
    if (!payload) {
      req.auth = {
        user: null,
        guestSessionId,
        isGuest: true,
      };
      return next();
    }

    const dbUser = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, name: true, role: true, isActive: true, isEmailVerified: true },
    });

    if (!dbUser || !dbUser.isActive) {
      req.auth = {
        user: null,
        guestSessionId,
        isGuest: true,
      };
      return next();
    }

    req.auth = {
      user: {
        id: dbUser.id,
        email: dbUser.email,
        name: dbUser.name,
        role: dbUser.role as 'USER' | 'ADMIN',
        isEmailVerified: Boolean(dbUser.isEmailVerified),
      },
      guestSessionId,
      isGuest: false,
    };

    next();
  } catch {
    req.auth = {
      user: null,
      guestSessionId: crypto.randomUUID(),
      isGuest: true,
    };
    next();
  }
}

/**
 * Guard middleware requiring authenticated user
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.auth?.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  next();
}

/**
 * Guard middleware requiring administrator privileges
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.auth?.user || req.auth.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Administrator access required.' });
  }
  next();
}

export function setAuthCookie(res: Response, payload: UserSessionPayload) {
  const token = signSessionToken(payload);
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/',
  });
  return token;
}

export function clearAuthCookie(res: Response) {
  res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
}
