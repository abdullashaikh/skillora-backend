import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { setAuthCookie, clearAuthCookie, requireAuth } from '../lib/auth/session.js';
import { EmailService } from '../lib/email/email-service.js';
import { GoogleAuthService } from '../lib/auth/google-auth-service.js';

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
 * Returns the most recent analysisId if one was claimed.
 */
async function claimGuestData(userId: string, guestSessionId: string | undefined): Promise<string | null> {
  if (!guestSessionId) return null;
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const pendingAnalysis = await prisma.resumeAnalysis.findFirst({
      where: {
        guestSessionId,
        userId: null,
        createdAt: { gte: oneDayAgo },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

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

    return pendingAnalysis?.id || null;
  } catch (err) {
    console.error('[Claim Guest Data Error]:', err);
    return null;
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

    if (!user || !user.isActive || user.accountStatus === 'SUSPENDED' || user.accountStatus === 'DELETED') {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (!user.passwordHash) {
      return res.status(401).json({
        error: 'This account was created with Google sign-in. Please sign in with Google.',
      });
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
router.get('/me', async (req: Request, res: Response) => {
  if (!req.auth?.user) {
    return res.json({
      user: null,
      isGuest: true,
      guestSessionId: req.auth?.guestSessionId,
    });
  }

  try {
    const dbUser = await prisma.user.findUnique({
      where: { id: req.auth.user.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isEmailVerified: true,
        passwordHash: true,
        identities: {
          select: { provider: true, createdAt: true },
        },
      },
    });

    if (!dbUser) {
      return res.json({
        user: null,
        isGuest: true,
        guestSessionId: req.auth?.guestSessionId,
      });
    }

    return res.json({
      user: {
        id: dbUser.id,
        email: dbUser.email,
        name: dbUser.name,
        role: dbUser.role,
        isEmailVerified: dbUser.isEmailVerified,
        hasPassword: Boolean(dbUser.passwordHash),
        identities: dbUser.identities,
      },
      isGuest: false,
      guestSessionId: req.auth?.guestSessionId,
    });
  } catch {
    return res.json({
      user: req.auth.user,
      isGuest: false,
      guestSessionId: req.auth?.guestSessionId,
    });
  }
});

// GET /api/auth/google/status
router.get('/google/status', (_req: Request, res: Response) => {
  return res.json(GoogleAuthService.getPublicConfig());
});

// GET /api/auth/google
router.get('/google', (req: Request, res: Response) => {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';

  if (!GoogleAuthService.isConfigured()) {
    return res.redirect(`${clientUrl}/login?error=google_not_configured`);
  }

  const rawRedirect = req.query.redirect as string | undefined;
  const returnUrl = GoogleAuthService.sanitizeRedirectUrl(rawRedirect);
  const action = req.query.action === 'link' ? 'link' : 'login';

  const { stateToken } = GoogleAuthService.generateState({
    returnUrl,
    guestSessionId: req.auth?.guestSessionId,
    action,
  });

  // Store state in secure HTTP-only cookie with 15-minute lifetime
  res.cookie('oauth_state', stateToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 15 * 60 * 1000,
    path: '/',
  });

  const authUrl = GoogleAuthService.generateAuthUrl(stateToken);
  return res.redirect(authUrl);
});

// GET /api/auth/google/callback
router.get('/google/callback', async (req: Request, res: Response) => {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';

  // Check for cancellation or provider error
  if (req.query.error) {
    res.clearCookie('oauth_state', { path: '/' });
    const errCode = req.query.error === 'access_denied' ? 'google_cancelled' : 'google_error';
    return res.redirect(`${clientUrl}/login?error=${errCode}`);
  }

  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const storedState = req.cookies?.oauth_state;

  res.clearCookie('oauth_state', { path: '/' });

  if (!code || !state || !storedState || state !== storedState) {
    return res.redirect(`${clientUrl}/login?error=invalid_oauth_state`);
  }

  const decodedState = GoogleAuthService.verifyState(state);
  if (!decodedState) {
    return res.redirect(`${clientUrl}/login?error=expired_oauth_state`);
  }

  try {
    // 1. Exchange code for verified Google identity
    const googleUser = await GoogleAuthService.exchangeCodeAndVerify(code);

    // 2. Check for existing Google UserIdentity
    const existingIdentity = await prisma.userIdentity.findUnique({
      where: {
        provider_providerSubject: {
          provider: 'google',
          providerSubject: googleUser.sub,
        },
      },
      include: { user: true },
    });

    if (existingIdentity) {
      const user = existingIdentity.user;
      if (!user.isActive || user.accountStatus === 'SUSPENDED' || user.accountStatus === 'DELETED') {
        return res.redirect(`${clientUrl}/login?error=account_suspended`);
      }

      await prisma.userIdentity.update({
        where: { id: existingIdentity.id },
        data: {
          lastLoginAt: new Date(),
          providerEmail: googleUser.email,
        },
      });

      // Update email verification if Google verified and user was previously unverified
      if (!user.isEmailVerified && googleUser.emailVerified) {
        await prisma.user.update({
          where: { id: user.id },
          data: { isEmailVerified: true, emailVerifiedAt: new Date() },
        });
      }

      const claimedId = await claimGuestData(user.id, decodedState.guestSessionId || req.auth?.guestSessionId);

      setAuthCookie(res, {
        userId: user.id,
        email: user.email,
        role: user.role,
      });

      const dest = claimedId ? `/analysis/${claimedId}` : (decodedState.returnUrl || '/dashboard');
      return res.redirect(`${clientUrl}${dest}`);
    }

    // 3. Check if an account with this email already exists
    const existingEmailUser = await prisma.user.findUnique({
      where: { email: googleUser.email },
      include: { identities: true },
    });

    if (existingEmailUser) {
      // If user is ALREADY authenticated in the current session (or explicit linking flow), link securely
      const currentLoggedInId = req.auth?.user?.id;
      if (currentLoggedInId && currentLoggedInId === existingEmailUser.id) {
        await prisma.userIdentity.create({
          data: {
            userId: existingEmailUser.id,
            provider: 'google',
            providerIssuer: 'https://accounts.google.com',
            providerSubject: googleUser.sub,
            providerEmail: googleUser.email,
          },
        });

        if (!existingEmailUser.isEmailVerified && googleUser.emailVerified) {
          await prisma.user.update({
            where: { id: existingEmailUser.id },
            data: { isEmailVerified: true, emailVerifiedAt: new Date() },
          });
        }

        const claimedId = await claimGuestData(existingEmailUser.id, decodedState.guestSessionId || req.auth?.guestSessionId);
        setAuthCookie(res, {
          userId: existingEmailUser.id,
          email: existingEmailUser.email,
          role: existingEmailUser.role,
        });

        const dest = claimedId ? `/analysis/${claimedId}` : (decodedState.returnUrl || '/dashboard');
        return res.redirect(`${clientUrl}${dest}?linked=google`);
      }

      // Security requirement: DO NOT auto-link without authentication!
      // Require the user to authenticate to the existing account first
      return res.redirect(
        `${clientUrl}/login?error=account_exists_link_required&email=${encodeURIComponent(googleUser.email)}`
      );
    }

    // 4. Create new User with linked Google Identity
    const isVerified = Boolean(googleUser.emailVerified);
    const newUser = await prisma.user.create({
      data: {
        email: googleUser.email,
        name: googleUser.name || null,
        passwordHash: null,
        role: 'USER',
        isEmailVerified: isVerified,
        emailVerifiedAt: isVerified ? new Date() : null,
        accountStatus: 'ACTIVE',
        identities: {
          create: {
            provider: 'google',
            providerIssuer: 'https://accounts.google.com',
            providerSubject: googleUser.sub,
            providerEmail: googleUser.email,
          },
        },
      },
    });

    if (!isVerified) {
      // If Google did not verify the email, create verification token and send email
      const { token, tokenHash } = EmailService.generateSecureToken();
      await prisma.verificationToken.create({
        data: {
          userId: newUser.id,
          tokenHash,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
      await EmailService.sendVerificationEmail(newUser.email, newUser.name, token);
    }

    const claimedId = await claimGuestData(newUser.id, decodedState.guestSessionId || req.auth?.guestSessionId);

    setAuthCookie(res, {
      userId: newUser.id,
      email: newUser.email,
      role: newUser.role,
    });

    let dest = '/dashboard';
    if (claimedId) {
      dest = `/analysis/${claimedId}`;
    } else if (!isVerified) {
      dest = '/verification-pending';
    } else if (decodedState.returnUrl) {
      dest = decodedState.returnUrl;
    }

    return res.redirect(`${clientUrl}${dest}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Google authentication failed';
    console.error('[Google Auth Callback Error]:', err);
    return res.redirect(`${clientUrl}/login?error=google_failed&detail=${encodeURIComponent(message.slice(0, 80))}`);
  }
});

// POST /api/auth/google/unlink
router.post('/google/unlink', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.auth!.user!.id;
    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      include: { identities: true },
    });

    if (!dbUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const googleIdentity = dbUser.identities.find((i) => i.provider === 'google');
    if (!googleIdentity) {
      return res.status(400).json({ error: 'No Google account is linked to this user.' });
    }

    // Require that the user has a password set so they don't lock themselves out
    if (!dbUser.passwordHash) {
      return res.status(400).json({
        error: 'You must set an account password before unlinking your Google account.',
      });
    }

    await prisma.userIdentity.delete({
      where: { id: googleIdentity.id },
    });

    return res.json({ success: true, message: 'Google account unlinked successfully.' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to unlink Google account.';
    return res.status(500).json({ error: message });
  }
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
