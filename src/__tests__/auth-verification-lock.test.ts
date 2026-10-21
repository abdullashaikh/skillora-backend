import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { prisma } from '../lib/db.js';
import { EmailService } from '../lib/email/email-service.js';

describe('Auth, Email Verification, Password Reset & Guest Quota Locking', () => {
  const testEmail = `test_lock_${Date.now()}@example.com`;
  const testPassword = 'Password123!';
  let verifiedUserId: string;
  let verifiedCookie: string;
  let unverifiedCookie: string;
  let guestSessionCookie: string;
  let guestAnalysisId: string;

  beforeAll(async () => {
    // Clean up any test users
    await prisma.user.deleteMany({
      where: { email: { contains: 'test_lock_' } },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { contains: 'test_lock_' } },
    });
  });

  describe('1. Token Security & Hashing', () => {
    it('should generate secure tokens and deterministic SHA-256 hashes', () => {
      const { token, tokenHash } = EmailService.generateSecureToken();
      expect(token).toHaveLength(64);
      expect(tokenHash).toHaveLength(64);

      const recomputedHash = EmailService.hashToken(token);
      expect(recomputedHash).toBe(tokenHash);
    });
  });

  describe('2. Registration & Email Verification Workflow', () => {
    it('should register a new user as unverified and create a verification token', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          email: testEmail,
          password: testPassword,
          name: 'Test Lock User',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.isEmailVerified).toBe(false);
      verifiedUserId = res.body.user.id;

      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      unverifiedCookie = cookies.find((c: string) => c.startsWith('skilled_auth_token=')) || '';

      // Check DB for VerificationToken
      const tokenRecord = await prisma.verificationToken.findFirst({
        where: { userId: verifiedUserId },
      });
      expect(tokenRecord).toBeDefined();
      expect(tokenRecord?.usedAt).toBeNull();
      expect(tokenRecord?.tokenHash).toBeDefined();
    });

    it('should reject invalid or expired email verification tokens', async () => {
      const res = await request(app)
        .post('/api/auth/verify-email')
        .send({ token: 'completely_invalid_token_12345' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('invalid, expired, or has already been used');
    });

    it('should successfully verify email when given a valid token, and prevent token reuse', async () => {
      // Find the created token
      const tokenRecord = await prisma.verificationToken.findFirst({
        where: { userId: verifiedUserId, usedAt: null },
      });
      expect(tokenRecord).toBeDefined();

      // Create a known token for verification test
      const { token, tokenHash } = EmailService.generateSecureToken();
      await prisma.verificationToken.create({
        data: {
          userId: verifiedUserId,
          tokenHash,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      // Verify email
      const verifyRes = await request(app)
        .post('/api/auth/verify-email')
        .send({ token });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.success).toBe(true);

      // Verify DB state
      const updatedUser = await prisma.user.findUnique({
        where: { id: verifiedUserId },
      });
      expect(updatedUser?.isEmailVerified).toBe(true);
      expect(updatedUser?.emailVerifiedAt).toBeDefined();

      // Attempt to reuse same token
      const reuseRes = await request(app)
        .post('/api/auth/verify-email')
        .send({ token });

      expect(reuseRes.status).toBe(400);
    });
  });

  describe('3. Forgot Password & Password Reset Workflow', () => {
    it('should return a generic confirmation message for forgot-password', async () => {
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: testEmail });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('If an account exists');
    });

    it('should return the exact same generic message for non-existent emails (no user enumeration)', async () => {
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'non_existent_random_email_9999@example.com' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('If an account exists');
    });

    it('should reset password with valid token and reject reuse', async () => {
      const { token, tokenHash } = EmailService.generateSecureToken();
      await prisma.passwordResetToken.create({
        data: {
          userId: verifiedUserId,
          tokenHash,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });

      const newPassword = 'NewSecretPassword456!';
      const resetRes = await request(app)
        .post('/api/auth/reset-password')
        .send({ token, password: newPassword });

      expect(resetRes.status).toBe(200);
      expect(resetRes.body.success).toBe(true);

      // Verify can login with new password
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: testEmail, password: newPassword });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.success).toBe(true);

      const cookies = loginRes.headers['set-cookie'];
      verifiedCookie = cookies.find((c: string) => c.startsWith('skilled_auth_token=')) || '';

      // Verify token cannot be reused
      const reuseRes = await request(app)
        .post('/api/auth/reset-password')
        .send({ token, password: 'AnotherPassword789!' });

      expect(reuseRes.status).toBe(400);
    });
  });

  describe('4. Guest Single Upload Quota & Locked Response Enforcement', () => {
    const dummyPdf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Title (Test Resume) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'
    );

    it('should enforce locked response for guest analysis, hiding skills and breakdown', async () => {
      // Create guest analysis directly in DB to test locking and quota
      const guestSessionId = `guest_test_${Date.now()}`;
      guestSessionCookie = `skilled_guest_session=${guestSessionId}`;

      const analysis = await prisma.resumeAnalysis.create({
        data: {
          guestSessionId,
          status: 'COMPLETED',
          qualityScore: 88,
          jobMatchScore: null,
          scoreBreakdown: JSON.stringify({
            qualityDimensions: [{ name: 'Skills Clarity', score: 90 }],
            suggestions: ['Add more metrics'],
          }),
          extractedProfile: JSON.stringify({
            summary: 'Confidential Resume Details',
            experience: [{ company: 'Secret Corp' }],
          }),
          isGuest: true,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });

      guestAnalysisId = analysis.id;

      // Add a skill
      await prisma.resumeAnalysisSkill.create({
        data: {
          analysisId: analysis.id,
          rawName: 'React',
          canonicalName: 'React',
          category: 'Frameworks',
          confidence: 0.95,
        },
      });

      // Request as Guest
      const res = await request(app)
        .get(`/api/resume-analyses/${guestAnalysisId}`)
        .set('Cookie', [guestSessionCookie]);

      expect(res.status).toBe(200);
      expect(res.body.isLocked).toBe(true);
      expect(res.body.lockReason).toBe('GUEST');
      expect(res.body.qualityScore).toBe(88);

      // CRITICAL: Ensure locked properties are NOT leaked to the guest!
      expect(res.body.skills).toEqual([]);
      expect(res.body.extractedProfile).toBeNull();
      expect(res.body.scoreBreakdown.qualityDimensions).toBeNull();
      expect(res.body.scoreBreakdown.suggestions).toBeNull();
    });

    it('should reject a second guest analysis when 1 analysis is already completed (Quota: 1)', async () => {
      // Since guestAnalysisId is already COMPLETED in DB for this guestSessionId,
      // a second attempt to upload should return HTTP 429
      const res = await request(app)
        .post('/api/resumes/analyze')
        .set('Cookie', [guestSessionCookie])
        .attach('file', dummyPdf, 'resume.pdf');

      expect(res.status).toBe(429);
      expect(res.body.error).toContain('Guest analysis limit reached');
      expect(res.body.isQuotaReached).toBe(true);
    });

    it('should unlock full report when accessed by the verified owner', async () => {
      // Transfer analysis to verified user
      await prisma.resumeAnalysis.update({
        where: { id: guestAnalysisId },
        data: { userId: verifiedUserId, isGuest: false },
      });

      const res = await request(app)
        .get(`/api/resume-analyses/${guestAnalysisId}`)
        .set('Cookie', [verifiedCookie]);

      expect(res.status).toBe(200);
      expect(res.body.isLocked).toBe(false);
      expect(res.body.lockReason).toBeNull();
      expect(res.body.qualityScore).toBe(88);

      // Unlocked: full breakdown and skills returned!
      expect(res.body.skills.length).toBeGreaterThan(0);
      expect(res.body.skills[0].canonicalName).toBe('React');
      expect(res.body.extractedProfile.summary).toBe('Confidential Resume Details');
      expect(res.body.scoreBreakdown.qualityDimensions).toBeDefined();
    });

    it('should deny access if another unassociated user attempts to access the report', async () => {
      const otherUserEmail = `other_user_${Date.now()}@example.com`;
      const otherRes = await request(app)
        .post('/api/auth/register')
        .send({
          email: otherUserEmail,
          password: 'OtherPassword123!',
          name: 'Other User',
        });

      const otherCookie = otherRes.headers['set-cookie'].find((c: string) => c.startsWith('skilled_auth_token='));

      const res = await request(app)
        .get(`/api/resume-analyses/${guestAnalysisId}`)
        .set('Cookie', [otherCookie]);

      expect(res.status).toBe(403);
    });
  });
});
