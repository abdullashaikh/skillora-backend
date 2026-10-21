import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { setAuthCookie, clearAuthCookie, requireAuth } from '../lib/auth/session.js';
import { EmailService } from '../lib/email/email-service.js';

const router = Router();

const RegisterSchema = z.object({
  email: z.string().email('Invalid email address').max(255),
  password: z.string().min(8, 'Password must be at least 8 characters long').max(100),
  name: z.string().min(1, 'Name is required').max(100),
});

const LoginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

const VerifyEmailSchema = z.object({
  token: z.string().min(1, 'Verification token is required'),
});

const ResendVerificationSchema = z.object({
  email: z.string().email('Invalid email address').optional(),
});

const ForgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

const ResetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  password: z.string().min(8, 'Password must be at least 8 characters long').max(100),
});

/**
 * Helper to safely claim pending guest resumes and analyses into an authenticated account.
 */
async function claimGuestData(userId: string, guestSessionId: string | undefined) {
  if (!guestSessionId) return;
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await prisma.resumeAnalysis.updateMany({
      where: {
        guestSessionId,
        userId: null,
        createdAt: { gte: oneDayAgo },
      },
      data: { userId },
    });
    await prisma.resume.updateMany({
      where: {
        guestSessionId,
        userId: null,
        createdAt: { gte: oneDayAgo },
      },
      data: { userId },
    });
  } catch (err) {
    console.error('[Claim Guest Data Error]:', err);
  }
}

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response) => {
  try {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Validation failed' });
    }

    const { email, password, name } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();

    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existingUser) {
      return res.status(409).json({ error: 'An account with this email address already exists.' });
    }

    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        name: name.trim(),
        role: 'USER',
        isActive: true,
        isEmailVerified: false,
        accountStatus: 'ACTIVE',
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isEmailVerified: true,
      },
    });

    // Claim any pending guest resume in this browser session
    await claimGuestData(user.id, req.auth?.guestSessionId);

    // Generate single-use verification token (24h expiry)
    const { token, tokenHash } = EmailService.generateSecureToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.verificationToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    // Send verification email
    await EmailService.sendVerificationEmail(user.email, user.name, token);

    const sessionToken = setAuthCookie(res, {
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    return res.json({
      success: true,
      user,
      token: sessionToken,
      message: 'Account registered successfully. Please check your email to verify your account.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Registration failed';
    return res.status(500).json({ error: message });
  }
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Validation failed' });
    }

    const { email, password } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Claim pending guest resume if any
    await claimGuestData(user.id, req.auth?.guestSessionId);

    const token = setAuthCookie(res, {
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    return res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        isEmailVerified: Boolean(user.isEmailVerified),
      },
      token,
      message: 'Signed in successfully.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Login failed';
    return res.status(500).json({ error: message });
  }
});

// POST /api/auth/logout
router.post('/logout', (_req: Request, res: Response) => {
  clearAuthCookie(res);
  return res.json({ success: true, message: 'Logged out successfully.' });
});

// GET /api/auth/me
router.get('/me', (req: Request, res: Response) => {
  return res.json({
    user: req.auth?.user || null,
    isGuest: req.auth?.isGuest ?? true,
    guestSessionId: req.auth?.guestSessionId,
  });
});

// POST /api/auth/verify-email
router.post('/verify-email', async (req: Request, res: Response) => {
  try {
    const parsed = VerifyEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid token' });
    }

    const tokenHash = EmailService.hashToken(parsed.data.token);

    const record = await prisma.verificationToken.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });

    if (!record || !record.user) {
      return res.status(400).json({
        error: 'This verification link is invalid, expired, or has already been used.',
      });
    }

    // Execute in transaction: consume token, verify user
    await prisma.$transaction([
      prisma.verificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      prisma.user.update({
        where: { id: record.userId },
        data: {
          isEmailVerified: true,
          emailVerifiedAt: new Date(),
        },
      }),
    ]);

    // Also claim any pending guest resume in this browser session
    await claimGuestData(record.userId, req.auth?.guestSessionId);

    // Refresh auth cookie if the user is currently signed in
    if (req.auth?.user?.id === record.userId) {
      setAuthCookie(res, {
        userId: record.user.id,
        email: record.user.email,
        role: record.user.role,
      });
    }

    return res.json({
      success: true,
      message: 'Email address verified successfully! Your full resume report and analysis features are now unlocked.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Email verification failed';
    return res.status(500).json({ error: message });
  }
});

// POST /api/auth/resend-verification
router.post('/resend-verification', async (req: Request, res: Response) => {
  try {
    const parsed = ResendVerificationSchema.safeParse(req.body);
    const targetEmail = parsed.success && parsed.data.email
      ? parsed.data.email.toLowerCase().trim()
      : req.auth?.user?.email;

    if (!targetEmail) {
      return res.status(400).json({ error: 'Email address is required.' });
    }

    const user = await prisma.user.findUnique({
      where: { email: targetEmail },
    });

    if (!user) {
      // Generic success to prevent account enumeration
      return res.json({
        success: true,
        message: 'If an unverified account exists for this email, a verification link has been sent.',
      });
    }

    if (user.isEmailVerified) {
      return res.status(400).json({ error: 'This email address is already verified.' });
    }

    // Cooldown check: prevent requesting more than once per 60 seconds
    const recentToken = await prisma.verificationToken.findFirst({
      where: {
        userId: user.id,
        createdAt: { gte: new Date(Date.now() - 60 * 1000) },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (recentToken) {
      return res.status(429).json({
        error: 'Please wait at least 60 seconds before requesting another verification email.',
      });
    }

    // Invalidate existing unused verification tokens
    await prisma.verificationToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    // Create new token
    const { token, tokenHash } = EmailService.generateSecureToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.verificationToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    await EmailService.sendVerificationEmail(user.email, user.name, token);

    return res.json({
      success: true,
      message: 'A fresh verification email has been sent. Please check your inbox.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to resend verification email';
    return res.status(500).json({ error: message });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const parsed = ForgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid email address' });
    }

    const normalizedEmail = parsed.data.email.toLowerCase().trim();

    // Constant generic message returned regardless of whether the account exists
    const genericResponse = {
      success: true,
      message: 'If an account exists for this email address, you will receive instructions to reset your password.',
    };

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user || !user.isActive) {
      return res.json(genericResponse);
    }

    // Cooldown check: 60s rate limit
    const recentReset = await prisma.passwordResetToken.findFirst({
      where: {
        userId: user.id,
        createdAt: { gte: new Date(Date.now() - 60 * 1000) },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (recentReset) {
      return res.json(genericResponse);
    }

    // Invalidate prior unused reset tokens
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    // Generate single-use reset token (30m expiry)
    const { token, tokenHash } = EmailService.generateSecureToken();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    await EmailService.sendPasswordResetEmail(user.email, user.name, token);

    return res.json(genericResponse);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to process request';
    return res.status(500).json({ error: message });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const parsed = ResetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Validation failed' });
    }

    const { token, password } = parsed.data;
    const tokenHash = EmailService.hashToken(token);

    const record = await prisma.passwordResetToken.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });

    if (!record || !record.user || !record.user.isActive) {
      return res.status(400).json({
        error: 'This password reset link is invalid, expired, or has already been used. Please request a new one.',
      });
    }

    const saltRounds = 12;
    const newPasswordHash = await bcrypt.hash(password, saltRounds);

    // Atomically consume token and update password
    await prisma.$transaction([
      prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash: newPasswordHash,
          isEmailVerified: true, // Resetting via verified email confirms ownership
          emailVerifiedAt: record.user.emailVerifiedAt || new Date(),
        },
      }),
    ]);

    // Invalidate existing sessions
    clearAuthCookie(res);

    // Send security notification email
    await EmailService.sendPasswordChangedNotification(record.user.email, record.user.name);

    return res.json({
      success: true,
      message: 'Your password has been reset successfully. Please sign in with your new password.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to reset password';
    return res.status(500).json({ error: message });
  }
});

// DELETE /api/auth/account
router.delete('/account', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.auth!.user!.id;
    await prisma.user.delete({
      where: { id: userId },
    });
    clearAuthCookie(res);
    return res.json({ success: true, message: 'Account deleted successfully.' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Account deletion failed';
    return res.status(500).json({ error: message });
  }
});

export default router;
