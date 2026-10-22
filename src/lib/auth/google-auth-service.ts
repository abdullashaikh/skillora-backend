import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';

export interface GoogleUserIdentityInfo {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
  issuer: string;
}

export interface OAuthStatePayload {
  state: string;
  nonce: string;
  returnUrl?: string;
  guestSessionId?: string;
  action?: 'login' | 'link';
  timestamp: number;
}

export class GoogleAuthService {
  private static getClientId(): string {
    return process.env.GOOGLE_CLIENT_ID?.trim() || '';
  }

  private static getClientSecret(): string {
    return process.env.GOOGLE_CLIENT_SECRET?.trim() || '';
  }

  private static getCallbackUrl(): string {
    return (
      process.env.GOOGLE_CALLBACK_URL?.trim() ||
      `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/auth/google/callback`
    );
  }

  public static isConfigured(): boolean {
    const clientId = this.getClientId();
    const clientSecret = this.getClientSecret();
    return Boolean(
      clientId &&
      clientSecret &&
      clientId !== 'your-google-oauth-client-id' &&
      clientSecret !== 'your-google-oauth-client-secret'
    );
  }

  public static getPublicConfig() {
    return {
      configured: this.isConfigured(),
      clientId: this.isConfigured() ? this.getClientId() : null,
    };
  }

  private static getOAuthClient(): OAuth2Client {
    return new OAuth2Client(
      this.getClientId(),
      this.getClientSecret(),
      this.getCallbackUrl()
    );
  }

  /**
   * Generates a signed, tamper-proof state string
   */
  public static generateState(payload: Omit<OAuthStatePayload, 'state' | 'nonce' | 'timestamp'>): {
    stateToken: string;
    rawState: string;
  } {
    const rawState = crypto.randomBytes(32).toString('hex');
    const nonce = crypto.randomBytes(16).toString('hex');
    const secret = process.env.JWT_SECRET || 'skilled-resume-oauth-fallback-secret-key';

    const fullPayload: OAuthStatePayload = {
      ...payload,
      state: rawState,
      nonce,
      timestamp: Date.now(),
    };

    const serialized = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', secret)
      .update(serialized)
      .digest('base64url');

    return {
      stateToken: `${serialized}.${signature}`,
      rawState,
    };
  }

  /**
   * Validates and unpacks a signed state string
   */
  public static verifyState(stateToken: string): OAuthStatePayload | null {
    try {
      const [serialized, signature] = stateToken.split('.');
      if (!serialized || !signature) return null;

      const secret = process.env.JWT_SECRET || 'skilled-resume-oauth-fallback-secret-key';
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(serialized)
        .digest('base64url');

      const sigBuffer = Buffer.from(signature);
      const expectedBuffer = Buffer.from(expectedSignature);
      if (
        sigBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
      ) {
        return null;
      }

      const decoded: OAuthStatePayload = JSON.parse(
        Buffer.from(serialized, 'base64url').toString('utf8')
      );

      // State tokens expire after 15 minutes
      if (Date.now() - decoded.timestamp > 15 * 60 * 1000) {
        return null;
      }

      return decoded;
    } catch {
      return null;
    }
  }

  /**
   * Generates the Google OAuth authorization URL
   */
  public static generateAuthUrl(stateToken: string, nonce?: string): string {
    if (!this.isConfigured()) {
      throw new Error('Google OAuth is not configured on this server.');
    }

    const client = this.getOAuthClient();
    return client.generateAuthUrl({
      access_type: 'online',
      scope: ['openid', 'email', 'profile'],
      state: stateToken,
      ...(nonce ? { nonce } : {}),
      prompt: 'select_account',
    });
  }

  /**
   * Exchanges authorization code for tokens and verifies ID token signature & claims
   */
  public static async exchangeCodeAndVerify(code: string): Promise<GoogleUserIdentityInfo> {
    if (!this.isConfigured()) {
      throw new Error('Google OAuth is not configured on this server.');
    }

    const client = this.getOAuthClient();
    const { tokens } = await client.getToken(code);

    if (!tokens.id_token) {
      throw new Error('Google did not return an ID token.');
    }

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: this.getClientId(),
    });

    const payload = ticket.getPayload();
    if (!payload) {
      throw new Error('Failed to extract Google user payload from ID token.');
    }

    const issuer = payload.iss;
    if (issuer !== 'https://accounts.google.com' && issuer !== 'accounts.google.com') {
      throw new Error(`Untrusted token issuer: ${issuer}`);
    }

    if (!payload.sub) {
      throw new Error('Google ID token is missing the subject (sub) claim.');
    }

    if (!payload.email) {
      throw new Error('Google ID token is missing the email claim.');
    }

    return {
      sub: payload.sub,
      email: payload.email.toLowerCase().trim(),
      emailVerified: Boolean(payload.email_verified),
      name: payload.name || undefined,
      picture: payload.picture || undefined,
      issuer,
    };
  }

  /**
   * Validates internal redirect path to prevent open redirect vulnerabilities
   */
  public static sanitizeRedirectUrl(url?: string): string {
    if (!url) return '/dashboard';
    const trimmed = url.trim();

    // Must start with single slash, not double slash (//evil.com), and cannot contain protocol
    if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
      return '/dashboard';
    }

    // Allowed path prefixes
    const allowedPrefixes = ['/dashboard', '/analysis/', '/', '/verification-pending'];
    const isAllowed = allowedPrefixes.some((prefix) => trimmed.startsWith(prefix));

    return isAllowed ? trimmed : '/dashboard';
  }
}
