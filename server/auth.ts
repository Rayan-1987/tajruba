import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Db } from './db.ts';
import type { Role } from './types.ts';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const SESSION_COOKIE = 'tajruba_session';
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionUser {
  id: string;
  tenantId: string;
  role: Role;
  departmentId: string | null;
  fullName: string;
  email: string;
  mfaEnabled: boolean;
}

interface UserRow {
  id: string;
  tenant_id: string;
  role: Role;
  department_id: string | null;
  full_name: string;
  email: string;
  active: number;
  mfa_enabled: number;
}

export function createSession(db: Db, userId: string): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)').run(
    randomBytes(16).toString('hex'),
    userId,
    tokenHash,
    expiresAt
  );
  return { token, expiresAt };
}

export function destroySession(db: Db, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

export function setSessionCookie(res: Response, token: string, expiresAt: string): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const expires = new Date(expiresAt).toUTCString();
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Expires=${expires}${secure}`
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function resolveSessionUser(db: Db, token: string): SessionUser | null {
  const tokenHash = hashToken(token);
  const session = db
    .prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
    .get(tokenHash) as { user_id: string; expires_at: string } | undefined;
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  const user = db
    .prepare('SELECT id, tenant_id, role, department_id, full_name, email, active, mfa_enabled FROM users WHERE id = ?')
    .get(session.user_id) as UserRow | undefined;
  if (!user || !user.active) return null;
  return {
    id: user.id,
    tenantId: user.tenant_id,
    role: user.role,
    departmentId: user.department_id,
    fullName: user.full_name,
    email: user.email,
    mfaEnabled: user.mfa_enabled === 1
  };
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
  }
}

export function attachSession(db: Db) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (token) {
      const user = resolveSessionUser(db, token);
      if (user) req.user = user;
    }
    next();
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}

export function readSessionToken(req: Request): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}
