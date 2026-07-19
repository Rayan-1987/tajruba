import { randomBytes, createHash } from 'node:crypto';
import { generate, generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';

/** A fresh base32 TOTP secret for one enrollment attempt. */
export async function createMfaSecret(): Promise<string> {
  return generateSecret();
}

/** True if `token` is a currently-valid 6-digit TOTP code for `secret`. */
export async function verifyMfaToken(token: string, secret: string): Promise<boolean> {
  const result = await verify({ token, secret });
  return result.valid;
}

/** otpauth:// URI an authenticator app scans to add the account, rendered as a QR code data URL. */
export async function buildEnrollmentQrCode(secret: string, accountEmail: string): Promise<{ otpauthUri: string; qrCodeDataUrl: string }> {
  const otpauthUri = await generateURI({ secret, label: accountEmail, issuer: 'Tajruba' });
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri, { width: 220, margin: 1 });
  return { otpauthUri, qrCodeDataUrl };
}

function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}

/** 8 one-time recovery codes for when the user's authenticator device is unavailable. */
export function generateRecoveryCodes(count = 8): { rawCodes: string[]; hashedCodes: string[] } {
  const rawCodes: string[] = [];
  const hashedCodes: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = randomBytes(5).toString('hex');
    rawCodes.push(code);
    hashedCodes.push(hashRecoveryCode(code));
  }
  return { rawCodes, hashedCodes };
}

/**
 * Checks `code` against the stored hashed recovery codes and, if it matches, returns the
 * remaining list with that code removed (one-time use). Returns null if no match.
 */
export function consumeRecoveryCode(storedHashedCodesJson: string | null, code: string): string[] | null {
  if (!storedHashedCodesJson) return null;
  const hashed: string[] = JSON.parse(storedHashedCodesJson);
  const target = hashRecoveryCode(code);
  const index = hashed.indexOf(target);
  if (index === -1) return null;
  hashed.splice(index, 1);
  return hashed;
}
