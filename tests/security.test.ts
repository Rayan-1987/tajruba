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
  app.use('/api', createApi(db, 'test-secret-at-least-32-characters-long'));
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
