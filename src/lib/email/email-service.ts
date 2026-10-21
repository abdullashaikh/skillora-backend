import nodemailer from 'nodemailer';
import crypto from 'crypto';

export interface EmailSendResult {
  success: boolean;
  messageId?: string;
  simulated?: boolean;
  previewUrl?: string;
  actionUrl?: string;
}

export class EmailService {
  private static getAppUrl(): string {
    return process.env.CLIENT_URL || process.env.APP_URL || 'http://localhost:3000';
  }

  private static getFromAddress(): string {
    return process.env.EMAIL_FROM || '"Skilled Resume" <noreply@skilledresume.com>';
  }

  private static createTransport() {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (host && user && pass) {
      return nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
    }

    return null;
  }

  /**
   * Generates a cryptographically secure random token and its SHA-256 hash.
   */
  static generateSecureToken(): { token: string; tokenHash: string } {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);
    return { token, tokenHash };
  }

  /**
   * Hashes a token using SHA-256.
   */
  static hashToken(token: string): string {
    return crypto.createHash('sha256').update(token.trim()).digest('hex');
  }

  /**
   * Sends an email verification link to a newly registered user.
   */
  static async sendVerificationEmail(
    toEmail: string,
    name: string | null,
    token: string
  ): Promise<EmailSendResult> {
    const appUrl = this.getAppUrl();
    const verificationUrl = `${appUrl}/verify-email?token=${token}`;
    const displayName = name ? name.trim() : 'there';

    const subject = 'Verify your Skilled Resume email address';
    const textBody = `Hi ${displayName},\n\nThank you for signing up for Skilled Resume. Please verify your email address by visiting the link below:\n\n${verificationUrl}\n\nThis verification link will expire in 24 hours.\n\nIf you did not create an account, you can safely ignore this email.\n\n— The Skilled Resume Team`;

    const htmlBody = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Verify your email</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 24px; }
            .container { max-width: 580px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
            .logo { font-size: 20px; font-weight: 700; color: #4f46e5; margin-bottom: 24px; letter-spacing: -0.5px; }
            h1 { font-size: 22px; font-weight: 700; color: #0f172a; margin-top: 0; }
            p { font-size: 15px; line-height: 1.6; color: #475569; margin: 16px 0; }
            .btn { display: inline-block; background-color: #4f46e5; color: #ffffff !important; font-weight: 600; font-size: 15px; padding: 12px 28px; text-decoration: none; border-radius: 8px; margin: 20px 0; text-align: center; }
            .footer { font-size: 13px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 20px; margin-top: 28px; }
            .url-box { background-color: #f1f5f9; padding: 10px; border-radius: 6px; font-size: 12px; color: #64748b; word-break: break-all; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="logo">⚡ Skilled Resume</div>
            <h1>Confirm your email address</h1>
            <p>Hi ${displayName},</p>
            <p>Welcome to Skilled Resume. To complete your account setup and unlock your full resume report and analysis features, please confirm your email address:</p>
            <div style="text-align: center;">
              <a href="${verificationUrl}" class="btn" target="_blank">Verify Email Address</a>
            </div>
            <p>Or copy and paste this URL into your browser:</p>
            <div class="url-box">${verificationUrl}</div>
            <p>This link expires in 24 hours. If you did not create an account on Skilled Resume, you can safely ignore this message.</p>
            <div class="footer">
              &copy; ${new Date().getFullYear()} Skilled Resume Inc. All rights reserved.
            </div>
          </div>
        </body>
      </html>
    `;

    return this.deliverEmail(toEmail, subject, textBody, htmlBody, verificationUrl);
  }

  /**
   * Sends a password reset email with a secure single-use link.
   */
  static async sendPasswordResetEmail(
    toEmail: string,
    name: string | null,
    token: string
  ): Promise<EmailSendResult> {
    const appUrl = this.getAppUrl();
    const resetUrl = `${appUrl}/reset-password?token=${token}`;
    const displayName = name ? name.trim() : 'there';

    const subject = 'Reset your Skilled Resume password';
    const textBody = `Hi ${displayName},\n\nA password reset was requested for your Skilled Resume account. Click the link below to set a new password:\n\n${resetUrl}\n\nThis single-use link will expire in 30 minutes.\n\nIf you did not request a password reset, please ignore this email. Your account remains completely secure.\n\n— The Skilled Resume Team`;

    const htmlBody = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Reset Password</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 24px; }
            .container { max-width: 580px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
            .logo { font-size: 20px; font-weight: 700; color: #4f46e5; margin-bottom: 24px; letter-spacing: -0.5px; }
            h1 { font-size: 22px; font-weight: 700; color: #0f172a; margin-top: 0; }
            p { font-size: 15px; line-height: 1.6; color: #475569; margin: 16px 0; }
            .btn { display: inline-block; background-color: #dc2626; color: #ffffff !important; font-weight: 600; font-size: 15px; padding: 12px 28px; text-decoration: none; border-radius: 8px; margin: 20px 0; text-align: center; }
            .footer { font-size: 13px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 20px; margin-top: 28px; }
            .url-box { background-color: #f1f5f9; padding: 10px; border-radius: 6px; font-size: 12px; color: #64748b; word-break: break-all; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="logo">⚡ Skilled Resume</div>
            <h1>Password Reset Request</h1>
            <p>Hi ${displayName},</p>
            <p>We received a request to reset the password for your Skilled Resume account. Click the button below to choose a new password:</p>
            <div style="text-align: center;">
              <a href="${resetUrl}" class="btn" target="_blank">Reset Password</a>
            </div>
            <p>Or paste this link into your browser:</p>
            <div class="url-box">${resetUrl}</div>
            <p><strong>This single-use link expires in 30 minutes.</strong> If you did not make this request, you can safely ignore this email; your password will not change.</p>
            <div class="footer">
              &copy; ${new Date().getFullYear()} Skilled Resume Inc. All rights reserved.
            </div>
          </div>
        </body>
      </html>
    `;

    return this.deliverEmail(toEmail, subject, textBody, htmlBody, resetUrl);
  }

  /**
   * Sends a notification to the user that their password was changed.
   */
  static async sendPasswordChangedNotification(
    toEmail: string,
    name: string | null
  ): Promise<EmailSendResult> {
    const displayName = name ? name.trim() : 'there';
    const subject = 'Your Skilled Resume password was changed';
    const textBody = `Hi ${displayName},\n\nThis is a security confirmation that your Skilled Resume password was recently changed.\n\nIf you did this, no further action is required.\n\nIf you did NOT change your password, please contact our support team immediately or request a password reset.\n\n— The Skilled Resume Team`;

    const htmlBody = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Password Changed</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 24px; }
            .container { max-width: 580px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
            .logo { font-size: 20px; font-weight: 700; color: #4f46e5; margin-bottom: 24px; letter-spacing: -0.5px; }
            h1 { font-size: 22px; font-weight: 700; color: #0f172a; margin-top: 0; }
            p { font-size: 15px; line-height: 1.6; color: #475569; margin: 16px 0; }
            .alert-box { background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 14px; margin: 16px 0; color: #991b1b; font-size: 14px; }
            .footer { font-size: 13px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 20px; margin-top: 28px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="logo">⚡ Skilled Resume</div>
            <h1>Password Successfully Updated</h1>
            <p>Hi ${displayName},</p>
            <p>Your Skilled Resume account password has been changed successfully.</p>
            <div class="alert-box">
              If you did not authorize this change, please request a password reset or contact our support team immediately.
            </div>
            <div class="footer">
              &copy; ${new Date().getFullYear()} Skilled Resume Inc. All rights reserved.
            </div>
          </div>
        </body>
      </html>
    `;

    return this.deliverEmail(toEmail, subject, textBody, htmlBody);
  }

  /**
   * Handles delivery via SMTP or local developer simulation.
   */
  private static async deliverEmail(
    to: string,
    subject: string,
    text: string,
    html: string,
    actionUrl?: string
  ): Promise<EmailSendResult> {
    const transport = this.createTransport();

    if (transport) {
      try {
        const info = await transport.sendMail({
          from: this.getFromAddress(),
          to,
          subject,
          text,
          html,
        });

        console.log(`[Email Service] Sent email "${subject}" to ${to} (MessageId: ${info.messageId})`);
        return {
          success: true,
          messageId: info.messageId,
          simulated: false,
          actionUrl,
        };
      } catch (err: unknown) {
        console.error(`[Email Service] Failed sending to ${to}:`, err);
        // Fall back to simulation log in development if SMTP delivery fails
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[Email Service] Falling back to console simulation for development.');
        } else {
          throw err;
        }
      }
    }

    // Development / test simulation mode
    console.log('\n======================================================');
    console.log('📨 [EMAIL SIMULATED IN DEVELOPMENT / TEST MODE]');
    console.log(`To:      ${to}`);
    console.log(`Subject: ${subject}`);
    if (actionUrl) {
      console.log(`🔗 Action Link: ${actionUrl}`);
    }
    console.log('======================================================\n');

    return {
      success: true,
      simulated: true,
      actionUrl,
    };
  }
}
