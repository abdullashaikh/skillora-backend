import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // 96-bit nonce recommended for AES-GCM
const AUTH_TAG_LENGTH_BYTES = 16;

/**
 * Retrieves the 32-byte encryption key from environment variable APP_ENCRYPTION_KEY.
 * Throws a descriptive error if not set or invalid length.
 */
function getMasterKey(): Buffer {
  const hexKey = process.env.APP_ENCRYPTION_KEY;
  if (!hexKey) {
    throw new Error('APP_ENCRYPTION_KEY environment variable is not configured.');
  }

  const keyBuffer = Buffer.from(hexKey, 'hex');
  if (keyBuffer.length !== 32) {
    throw new Error(
      `APP_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters). Found: ${keyBuffer.length} bytes.`
    );
  }

  return keyBuffer;
}

export interface EncryptedPayload {
  ciphertext: string; // Hex encoded
  iv: string;         // Hex encoded
  authTag: string;    // Hex encoded
}

/**
 * Encrypts sensitive secret material (such as API keys) using AES-256-GCM.
 * Uses a unique, cryptographically random IV for every operation.
 */
export function encryptSecret(plainText: string): EncryptedPayload {
  if (!plainText || plainText.trim() === '') {
    throw new Error('Cannot encrypt empty or null secret.');
  }

  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });

  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    ciphertext: encrypted,
    iv: iv.toString('hex'),
    authTag,
  };
}

/**
 * Decrypts AES-256-GCM encrypted secret. Authenticates ciphertext and tag.
 */
export function decryptSecret(payload: EncryptedPayload): string {
  if (!payload.ciphertext || !payload.iv || !payload.authTag) {
    throw new Error('Incomplete encrypted payload: ciphertext, iv, and authTag are required.');
  }

  const key = getMasterKey();
  const iv = Buffer.from(payload.iv, 'hex');
  const authTag = Buffer.from(payload.authTag, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(payload.ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Masks an API credential for safe admin display.
 * Shows only the prefix pattern and the last 4 characters, concealing the rest.
 * Example: "sk-proj-1234567890abcdef" -> "sk-••••••••cdef"
 */
export function maskApiKey(apiKey: string): string {
  if (!apiKey || apiKey.length < 8) {
    return '••••••••';
  }

  const last4 = apiKey.slice(-4);
  let prefix = '';
  if (apiKey.startsWith('sk-')) {
    prefix = 'sk-';
  } else if (apiKey.startsWith('AIza')) {
    prefix = 'AIza';
  }

  return `${prefix}••••••••${last4}`;
}
