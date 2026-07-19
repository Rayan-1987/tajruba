import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { openDatabase } from '../server/db.ts';
import { seedDatabase } from '../server/seed.ts';
import { createApi } from '../server/api.ts';
import { hashPassword } from '../server/auth.ts';

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

test('unauthenticated requests to protected reports are rejected', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/api/reports/scores`);
    assert.equal(res.status, 401);
  } finally {
    server.close();
    db.close();
  }
});

test('login rejects wrong password and accepts the right one', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const bad = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@tajruba.sa', password: 'wrong-password' })
    });
    assert.equal(bad.status, 401);

    const cookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    const body = (await me.json()) as { user: { email: string } };
    assert.equal(body.user.email, 'admin@tajruba.sa');
  } finally {
    server.close();
    db.close();
  }
});

test('a department manager cannot read another department scores', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const cookie = await login(baseUrl, 'department@tajruba.sa', 'Department123!');
    const departments = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie } })).json()) as {
      departments: { id: string; service_type: string }[];
    };
    const otherDept = departments.departments.find((d) => d.service_type !== 'ED')!;

    const forbidden = await fetch(`${baseUrl}/api/reports/scores?departmentId=${otherDept.id}`, { headers: { cookie } });
    assert.equal(forbidden.status, 403);

    const own = await fetch(`${baseUrl}/api/reports/scores`, { headers: { cookie } });
    assert.equal(own.status, 200);
  } finally {
    server.close();
    db.close();
  }
});

test('only quality managers (or admins) can close a service recovery case', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const deptCookie = await login(baseUrl, 'department@tajruba.sa', 'Department123!');
    const cases = (await (await fetch(`${baseUrl}/api/service-recovery/cases`, { headers: { cookie: deptCookie } })).json()) as {
      cases: { id: string }[];
    };
    assert.ok(cases.cases.length > 0, 'expected seeded service recovery cases');
    const caseId = cases.cases[0].id;

    // The comment id backing the case status endpoint is the comment_id, not the case id.
    const commentRow = db.prepare('SELECT comment_id FROM service_recovery_cases WHERE id = ?').get(caseId) as {
      comment_id: string;
    };

    const deniedClose = await fetch(`${baseUrl}/api/comments/${commentRow.comment_id}/status`, {
      method: 'PATCH',
      headers: { cookie: deptCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'closed' })
    });
    assert.equal(deniedClose.status, 403);

    const qualityCookie = await login(baseUrl, 'quality@tajruba.sa', 'Quality123!');
    const allowedClose = await fetch(`${baseUrl}/api/comments/${commentRow.comment_id}/status`, {
      method: 'PATCH',
      headers: { cookie: qualityCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'closed', resolutionNotes: 'تم الحل' })
    });
    assert.equal(allowedClose.status, 200);
  } finally {
    server.close();
    db.close();
  }
});

test('tenant isolation: a user from another tenant never sees the first tenant comments', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const otherTenantId = randomUUID();
    db.prepare('INSERT INTO tenants (id, name_ar, name_en, slug) VALUES (?, ?, ?, ?)').run(
      otherTenantId,
      'مستشفى آخر',
      'Other Hospital',
      'other-hospital'
    );
    const otherUserId = randomUUID();
    db.prepare(
      'INSERT INTO users (id, tenant_id, email, password_hash, role, department_id, full_name) VALUES (?, ?, ?, ?, ?, NULL, ?)'
    ).run(otherUserId, otherTenantId, 'quality@other.sa', hashPassword('OtherPass123!'), 'QualityManager', 'مدير جودة آخر');

    const cookie = await login(baseUrl, 'quality@other.sa', 'OtherPass123!');
    const res = await fetch(`${baseUrl}/api/comments`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { comments: unknown[] };
    assert.equal(body.comments.length, 0);
  } finally {
    server.close();
    db.close();
  }
});

test('PII is redacted before it is ever returned by the API', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const invitation = db
      .prepare("SELECT token_hash FROM survey_invitations WHERE status = 'sent' LIMIT 1")
      .get() as { token_hash: string } | undefined;
    assert.ok(invitation);

    // Use the known demo token instead of the hash (submit endpoint takes the raw token).
    const submitRes = await fetch(`${baseUrl}/api/public/surveys/demo-ed-token/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: [], comment: 'تواصلوا معي على 0512345678 بخصوص الشكوى', language: 'ar' })
    });
    assert.equal(submitRes.status, 201);

    const cookie = await login(baseUrl, 'quality@tajruba.sa', 'Quality123!');
    const res = await fetch(`${baseUrl}/api/comments`, { headers: { cookie } });
    const body = (await res.json()) as { comments: { redacted_text: string }[] };
    const found = body.comments.find((c) => c.redacted_text.includes('بخصوص الشكوى'));
    assert.ok(found, 'expected the redacted comment to be present');
    assert.ok(!found!.redacted_text.includes('0512345678'));
  } finally {
    server.close();
    db.close();
  }
});

test('self-service password reset: request, complete, then log in with the new password', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const forgotRes = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'department@tajruba.sa' })
    });
    assert.equal(forgotRes.status, 200);

    // The route only ever hands back {ok:true} (to avoid leaking which emails have accounts) —
    // the raw token exists only in the console-logged email, so recover it from the DB the same
    // way the proms tests recover SMS-only tokens: by reaching in directly.
    const user = db.prepare("SELECT id, password_reset_token_hash FROM users WHERE email = 'department@tajruba.sa'").get() as {
      id: string;
      password_reset_token_hash: string | null;
    };
    assert.ok(user.password_reset_token_hash, 'a reset token must have been issued');

    // We cannot invert the hash, so exercise the reset endpoint's rejection paths with a
    // fabricated token first, then complete the real flow by minting a token the same way the
    // server does and writing its hash directly (mirroring how proms.test.ts fabricates tokens).
    const badReset = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-token', newPassword: 'NewPassword123!' })
    });
    assert.equal(badReset.status, 400);

    const crypto = await import('node:crypto');
    const rawToken = 'test-reset-token-123';
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const farFuture = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.prepare('UPDATE users SET password_reset_token_hash = ?, password_reset_expires_at = ? WHERE id = ?').run(
      tokenHash,
      farFuture,
      user.id
    );

    const shortPasswordRes = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: rawToken, newPassword: 'short' })
    });
    assert.equal(shortPasswordRes.status, 400);

    const resetRes = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: rawToken, newPassword: 'NewPassword123!' })
    });
    assert.equal(resetRes.status, 200);

    // The token must be single-use.
    const reuseRes = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: rawToken, newPassword: 'AnotherPassword123!' })
    });
    assert.equal(reuseRes.status, 400);

    // The old password must no longer work, the new one must.
    const oldLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'department@tajruba.sa', password: 'Department123!' })
    });
    assert.equal(oldLoginRes.status, 401);

    const newLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'department@tajruba.sa', password: 'NewPassword123!' })
    });
    assert.equal(newLoginRes.status, 200);
  } finally {
    server.close();
    db.close();
  }
});

test('a reset token past its 30-minute expiry is rejected', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const user = db.prepare("SELECT id FROM users WHERE email = 'department@tajruba.sa'").get() as { id: string };
    const crypto = await import('node:crypto');
    const rawToken = 'expired-reset-token';
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    db.prepare('UPDATE users SET password_reset_token_hash = ?, password_reset_expires_at = ? WHERE id = ?').run(tokenHash, past, user.id);

    const res = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: rawToken, newPassword: 'SomePassword123!' })
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
    db.close();
  }
});

test('forgot-password never reveals whether an email address has an account', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const realRes = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@tajruba.sa' })
    });
    const fakeRes = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'no-such-account@tajruba.sa' })
    });
    assert.equal(realRes.status, fakeRes.status);
    assert.deepEqual(await realRes.json(), await fakeRes.json());
  } finally {
    server.close();
    db.close();
  }
});
