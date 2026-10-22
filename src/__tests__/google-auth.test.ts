import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { prisma } from '../lib/db.js';
import { GoogleAuthService } from '../lib/auth/google-auth-service.js';
import { setAuthCookie } from '../lib/auth/session.js';

describe('Google OAuth Authentication & Identity Linking', () => {
  const timestamp = Date.now();
  const testGoogleEmail = `google_user_${timestamp}@example.com`;
  const testExistingEmail = `existing_email_${timestamp}@example.com`;
  const testGoogleSub = `g_sub_${timestamp}_987654321`;

  let createdGoogleUserId: string;
  let existingUserId: string;
  let existingUserCookie: string;

  beforeAll(async () => {
    // Setup environment variables for test
    process.env.GOOGLE_CLIENT_ID = 'test-mock-google-client-id.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'test-mock-google-client-secret';
    process.env.GOOGLE_CALLBACK_URL = 'http://localhost:5000/api/auth/google/callback';

    // Create an existing email/password user to test linking protection
    const user = await prisma.user.create({
      data: {
        email: testExistingEmail,
        name: 'Existing Password User',
        passwordHash: '$2a$12$e/aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abcdefghijklmno',
        role: 'USER',
        isEmailVerified: true,
        accountStatus: 'ACTIVE',
      },
    });
    existingUserId = user.id;
  });

  afterAll(async () => {
    // Cleanup created test records
    await prisma.userIdentity.deleteMany({
      where: {
        OR: [
          { providerSubject: testGoogleSub },
          { providerEmail: { in: [testGoogleEmail, testExistingEmail] } },
        ],
      },
    });

    await prisma.user.deleteMany({
      where: {
        email: { in: [testGoogleEmail, testExistingEmail, `suspended_${timestamp}@example.com`] },
      },
    });
  });

  describe('1. State Token Generation, Verification & URL Sanitization', () => {
    it('should generate a valid cryptographically signed state token', () => {
      const { stateToken, rawState } = GoogleAuthService.generateState({
        returnUrl: '/analysis/12345',
        action: 'login',
      });

      expect(stateToken).toBeDefined();
      expect(rawState).toHaveLength(64);

      const verified = GoogleAuthService.verifyState(stateToken);
      expect(verified).not.toBeNull();
      expect(verified?.state).toBe(rawState);
      expect(verified?.returnUrl).toBe('/analysis/12345');
      expect(verified?.action).toBe('login');
    });

    it('should reject tampered or invalid state tokens', () => {
      const { stateToken } = GoogleAuthService.generateState({ returnUrl: '/dashboard' });
      const tampered = stateToken.slice(0, -5) + 'xxxxx';

      expect(GoogleAuthService.verifyState(tampered)).toBeNull();
      expect(GoogleAuthService.verifyState('invalid.token.payload')).toBeNull();
    });

    it('should sanitize redirect URLs to prevent open redirects', () => {
      expect(GoogleAuthService.sanitizeRedirectUrl('//evil.com')).toBe('/dashboard');
      expect(GoogleAuthService.sanitizeRedirectUrl('https://malicious.site')).toBe('/dashboard');
      expect(GoogleAuthService.sanitizeRedirectUrl('/analysis/report_123')).toBe('/analysis/report_123');
      expect(GoogleAuthService.sanitizeRedirectUrl('/dashboard')).toBe('/dashboard');
      expect(GoogleAuthService.sanitizeRedirectUrl('')).toBe('/dashboard');
    });
  });

  describe('2. Google Status & Initiation Endpoints', () => {
    it('should report configured status when client ID and secret are present', async () => {
      const res = await request(app).get('/api/auth/google/status');
      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
      expect(res.body.clientId).toBe(process.env.GOOGLE_CLIENT_ID);
    });

    it('should initiate Google OAuth redirect and set secure oauth_state cookie', async () => {
      const res = await request(app)
        .get('/api/auth/google?redirect=/analysis/abc')
        .expect(302);

      const redirectLocation = res.headers['location'];
      expect(redirectLocation).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      expect(redirectLocation).toContain('client_id=test-mock-google-client-id.apps.googleusercontent.com');
      expect(redirectLocation).toContain('scope=openid%20email%20profile');

      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const stateCookie = cookies.find((c: string) => c.startsWith('oauth_state='));
      expect(stateCookie).toBeDefined();
      expect(stateCookie).toContain('HttpOnly');
    });
  });

  describe('3. OAuth Callback: New User Registration via Google', () => {
    it('should reject callback with invalid or missing state parameter', async () => {
      const res = await request(app)
        .get('/api/auth/google/callback?code=mock_code&state=forged_state')
        .set('Cookie', ['oauth_state=valid_state']);

      expect(res.status).toBe(302);
      expect(res.headers['location']).toContain('/login?error=invalid_oauth_state');
    });

    it('should register a new user with verified email when Google confirms email_verified: true', async () => {
      // Mock Google exchangeCodeAndVerify to simulate Google ID token response
      vi.spyOn(GoogleAuthService, 'exchangeCodeAndVerify').mockResolvedValueOnce({
        sub: testGoogleSub,
        email: testGoogleEmail,
        emailVerified: true,
        name: 'Google Test User',
        issuer: 'https://accounts.google.com',
      });

      const { stateToken } = GoogleAuthService.generateState({
        returnUrl: '/dashboard',
        action: 'login',
      });

      const res = await request(app)
        .get(`/api/auth/google/callback?code=valid_mock_code&state=${stateToken}`)
        .set('Cookie', [`oauth_state=${stateToken}`]);

      expect(res.status).toBe(302);
      expect(res.headers['location']).toContain('/dashboard');

      // Verify session cookie was set
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const authCookie = cookies.find((c: string) => c.startsWith('skilled_auth_token='));
      expect(authCookie).toBeDefined();

      // Check database: User created with isEmailVerified = true and linked UserIdentity
      const dbUser = await prisma.user.findUnique({
        where: { email: testGoogleEmail },
        include: { identities: true },
      });

      expect(dbUser).not.toBeNull();
      expect(dbUser?.isEmailVerified).toBe(true);
      expect(dbUser?.passwordHash).toBeNull();
      expect(dbUser?.identities).toHaveLength(1);
      expect(dbUser?.identities[0].provider).toBe('google');
      expect(dbUser?.identities[0].providerSubject).toBe(testGoogleSub);

      createdGoogleUserId = dbUser!.id;
    });
  });

  describe('4. OAuth Callback: Existing Linked User Login', () => {
    it('should authenticate existing Google-linked user without creating duplicate accounts', async () => {
      vi.spyOn(GoogleAuthService, 'exchangeCodeAndVerify').mockResolvedValueOnce({
        sub: testGoogleSub,
        email: testGoogleEmail,
        emailVerified: true,
        name: 'Google Test User',
        issuer: 'https://accounts.google.com',
      });

      const { stateToken } = GoogleAuthService.generateState({
        returnUrl: '/dashboard',
        action: 'login',
      });

      const res = await request(app)
        .get(`/api/auth/google/callback?code=mock_code&state=${stateToken}`)
        .set('Cookie', [`oauth_state=${stateToken}`]);

      expect(res.status).toBe(302);
      expect(res.headers['location']).toContain('/dashboard');

      // Verify no duplicate users were created
      const count = await prisma.user.count({ where: { email: testGoogleEmail } });
      expect(count).toBe(1);
    });
  });

  describe('5. Account Linking Protection for Existing Password Users', () => {
    it('should prevent auto-linking and redirect with error when email matches an unlinked account', async () => {
      // Simulate Google returning the email of the existing password user
      vi.spyOn(GoogleAuthService, 'exchangeCodeAndVerify').mockResolvedValueOnce({
        sub: `unlinked_sub_${timestamp}`,
        email: testExistingEmail,
        emailVerified: true,
        name: 'Existing Password User',
        issuer: 'https://accounts.google.com',
      });

      const { stateToken } = GoogleAuthService.generateState({
        returnUrl: '/dashboard',
        action: 'login',
      });

      const res = await request(app)
        .get(`/api/auth/google/callback?code=mock_code&state=${stateToken}`)
        .set('Cookie', [`oauth_state=${stateToken}`]);

      expect(res.status).toBe(302);
      expect(res.headers['location']).toContain('/login?error=account_exists_link_required');
      expect(res.headers['location']).toContain(encodeURIComponent(testExistingEmail));

      // Ensure no Google identity was secretly linked without password authentication
      const user = await prisma.user.findUnique({
        where: { id: existingUserId },
        include: { identities: true },
      });
      expect(user?.identities).toHaveLength(0);
    });
  });

  describe('6. Suspended Account Enforcement', () => {
    it('should reject Google login if the account is suspended', async () => {
      const suspendedEmail = `suspended_${timestamp}@example.com`;
      const suspendedSub = `suspended_sub_${timestamp}`;

      const suspendedUser = await prisma.user.create({
        data: {
          email: suspendedEmail,
          name: 'Suspended User',
          passwordHash: null,
          role: 'USER',
          isEmailVerified: true,
          accountStatus: 'SUSPENDED',
          isActive: false,
          identities: {
            create: {
              provider: 'google',
              providerIssuer: 'https://accounts.google.com',
              providerSubject: suspendedSub,
              providerEmail: suspendedEmail,
            },
          },
        },
      });

      vi.spyOn(GoogleAuthService, 'exchangeCodeAndVerify').mockResolvedValueOnce({
        sub: suspendedSub,
        email: suspendedEmail,
        emailVerified: true,
        issuer: 'https://accounts.google.com',
      });

      const { stateToken } = GoogleAuthService.generateState({ returnUrl: '/dashboard' });

      const res = await request(app)
        .get(`/api/auth/google/callback?code=mock_code&state=${stateToken}`)
        .set('Cookie', [`oauth_state=${stateToken}`]);

      expect(res.status).toBe(302);
      expect(res.headers['location']).toContain('/login?error=account_suspended');

      // Cleanup
      await prisma.userIdentity.deleteMany({ where: { userId: suspendedUser.id } });
      await prisma.user.delete({ where: { id: suspendedUser.id } });
    });
  });

  describe('7. Unlinking Google Account Security', () => {
    it('should reject unlinking Google if the user has no password set (lockout prevention)', async () => {
      // createdGoogleUserId has no passwordHash
      const fakeRes = { cookie: () => {} } as any;
      const token = setAuthCookie(fakeRes, {
        userId: createdGoogleUserId,
        email: testGoogleEmail,
        role: 'USER',
      });

      const res = await request(app)
        .post('/api/auth/google/unlink')
        .set('Cookie', [`skilled_auth_token=${token}`]);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('You must set an account password before unlinking');
    });
  });
});
