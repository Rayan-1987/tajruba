import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';

// Field-level encryption at rest for the few columns that must stay in reversible plaintext to
// be usable (e.g. a phone number the hospital calls back), unlike the irreversible sha256
// hashes used elsewhere for the sampling frame. AES-256-GCM with a key derived from
// PII_ENCRYPTION_KEY; falls back to a fixed development key outside production so local/dev
// runs and tests don't require extra setup.
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.PII_ENCRYPTION_KEY;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('PII_ENCRYPTION_KEY must be configured in production.');
    }
    cachedKey = scryptSync('development-only-pii-key-change-before-deployment', 'tajruba-pii-salt', 32);
    return cachedKey;
  }
  cachedKey = scryptSync(secret, 'tajruba-pii-salt', 32);
  return cachedKey;
}

/** Encrypts a plaintext value for storage. Returns `${iv}:${authTag}:${ciphertext}` (all hex). */
export function encryptPii(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a value produced by encryptPii. Passes through unrecognized (non-encrypted) values
 * unchanged so pre-existing plaintext rows from before encryption was introduced still work.
 */
export function decryptPii(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const parts = stored.split(':');
  if (parts.length !== 3) return stored;
  const [ivHex, authTagHex, dataHex] = parts;
  try {
    const key = getKey();
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return stored;
  }
}
