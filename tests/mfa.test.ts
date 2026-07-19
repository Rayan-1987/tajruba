import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { generate } from 'otplib';
import { openDatabase } from '../server/db.ts';
import { seedDatabase } from '../server/seed.ts';
import { createApi } from '../server/api.ts';

const root = new URL('..', import.meta.url).pathname;

function startServer() {
  const db = openDatabase(':memory:');
  seedDatabase(db, root);
  const app = express();
  app.use('/api', createApi(db, 'test-secret-at-least-32-characters-long', root));
  return new Promise<{ server: Server; baseUrl: string; db: typeof db }>((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, db });
    });
  });
}

function extractCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0];
}

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(res.status, 200);
  return extractCookie(res);
}

test('a user can enroll in TOTP MFA, and login then requires the second factor', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const cookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');

    const enrollRes = await fetch(`${baseUrl}/api/auth/mfa/enroll`, { method: 'POST', headers: { cookie } });
    assert.equal(enrollRes.status, 200);
    const { secret, otpauthUri, qrCodeDataUrl } = (await enrollRes.json()) as {
      secret: string;
      otpauthUri: string;
      qrCodeDataUrl: string;
    };
    assert.ok(secret.length > 0);
    assert.ok(otpauthUri.startsWith('otpauth://totp/'));
    assert.ok(qrCodeDataUrl.startsWith('data:image/png;base64,'));

    // A bogus code must be rejected, and enrollment must not complete.
    const badVerify = await fetch(`${baseUrl}/api/auth/mfa/verify-enrollment`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000' })
    });
    assert.equal(badVerify.status, 400);

    const validCode = await generate({ secret });
    const verifyRes = await fetch(`${baseUrl}/api/auth/mfa/verify-enrollment`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ code: validCode })
    });
    assert.equal(verifyRes.status, 200);
    const { recoveryCodes } = (await verifyRes.json()) as { recoveryCodes: string[] };
    assert.equal(recoveryCodes.length, 8);

    // Logging out and back in now requires the TOTP step before a session is issued.
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@tajruba.sa', password: 'Tajruba123!' })
    });
    assert.equal(loginRes.status, 200);
    const loginBody = (await loginRes.json()) as { mfaRequired: boolean; challengeToken: string };
    assert.equal(loginBody.mfaRequired, true);
    assert.ok(loginBody.challengeToken);
    // No session cookie is set at this stage.
    assert.equal(loginRes.headers.get('set-cookie'), null);

    // A stale/expired challenge or wrong code must not grant a session.
    const wrongCodeRes = await fetch(`${baseUrl}/api/auth/mfa/verify-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeToken: loginBody.challengeToken, code: '111111' })
    });
    assert.equal(wrongCodeRes.status, 401);

    const secondValidCode = await generate({ secret });
    const verifyLoginRes = await fetch(`${baseUrl}/api/auth/mfa/verify-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeToken: loginBody.challengeToken, code: secondValidCode })
    });
    assert.equal(verifyLoginRes.status, 200);
    const sessionCookie = extractCookie(verifyLoginRes);
    assert.ok(sessionCookie.length > 0);

    const meRes = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: sessionCookie } });
    assert.equal(meRes.status, 200);

    // The same challenge token cannot be redeemed a second time.
    const replayRes = await fetch(`${baseUrl}/api/auth/mfa/verify-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeToken: loginBody.challengeToken, code: secondValidCode })
    });
    assert.equal(replayRes.status, 401);
  } finally {
    server.close();
  }
});

test('a recovery code can complete MFA login exactly once, and disabling MFA requires the password', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const cookie = await login(baseUrl, 'quality@tajruba.sa', 'Quality123!');
    const enrollRes = await fetch(`${baseUrl}/api/auth/mfa/enroll`, { method: 'POST', headers: { cookie } });
    const { secret } = (await enrollRes.json()) as { secret: string };
    const code = await generate({ secret });
    const verifyRes = await fetch(`${baseUrl}/api/auth/mfa/verify-enrollment`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const { recoveryCodes } = (await verifyRes.json()) as { recoveryCodes: string[] };

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'quality@tajruba.sa', password: 'Quality123!' })
    });
    const { challengeToken } = (await loginRes.json()) as { challengeToken: string };

    const recoveryLoginRes = await fetch(`${baseUrl}/api/auth/mfa/verify-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeToken, code: recoveryCodes[0] })
    });
    assert.equal(recoveryLoginRes.status, 200);
    const recoveryBody = (await recoveryLoginRes.json()) as { recoveryCodeUsed: boolean; remainingRecoveryCodes: number };
    assert.equal(recoveryBody.recoveryCodeUsed, true);
    assert.equal(recoveryBody.remainingRecoveryCodes, 7);
    const sessionCookie = extractCookie(recoveryLoginRes);

    // The same recovery code cannot be reused for a fresh login challenge.
    const secondLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'quality@tajruba.sa', password: 'Quality123!' })
    });
    const { challengeToken: secondChallenge } = (await secondLoginRes.json()) as { challengeToken: string };
    const reuseRes = await fetch(`${baseUrl}/api/auth/mfa/verify-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeToken: secondChallenge, code: recoveryCodes[0] })
    });
    assert.equal(reuseRes.status, 401);

    // Disabling MFA requires the current password, not just an authenticated session.
    const disableWrongPassword = await fetch(`${baseUrl}/api/auth/mfa/disable`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' })
    });
    assert.equal(disableWrongPassword.status, 401);

    const disableRes = await fetch(`${baseUrl}/api/auth/mfa/disable`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'Quality123!' })
    });
    assert.equal(disableRes.status, 200);

    // Login no longer requires MFA once disabled.
    const finalLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'quality@tajruba.sa', password: 'Quality123!' })
    });
    const finalBody = (await finalLoginRes.json()) as { mfaRequired: boolean };
    assert.equal(finalBody.mfaRequired, false);
  } finally {
    server.close();
  }
});
