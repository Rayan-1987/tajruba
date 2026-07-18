import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
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

async function registerHospital(baseUrl: string, suffix: string) {
  const res = await fetch(`${baseUrl}/api/tenants/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      hospitalNameAr: `مستشفى ${suffix}`,
      hospitalNameEn: `Hospital ${suffix}`,
      adminFullName: `Admin ${suffix}`,
      adminEmail: `admin-${suffix}@example.com`,
      adminPassword: 'SuperSecret123!'
    })
  });
  return { res, cookie: extractCookie(res) };
}

test('a new hospital can self-register and is immediately logged in', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const { res, cookie } = await registerHospital(baseUrl, 'alpha');
    assert.equal(res.status, 201);
    assert.ok(cookie.length > 0);

    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    const body = (await me.json()) as { user: { role: string; email: string } };
    assert.equal(body.user.role, 'SystemAdmin');
    assert.equal(body.user.email, 'admin-alpha@example.com');
  } finally {
    server.close();
    db.close();
  }
});

test('registering with an already-used email is rejected', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    await registerHospital(baseUrl, 'dup');
    const { res } = await registerHospital(baseUrl, 'dup');
    assert.equal(res.status, 409);
  } finally {
    server.close();
    db.close();
  }
});

test('a freshly-registered hospital gets its own independent question bank and departments', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const { cookie } = await registerHospital(baseUrl, 'beta');

    const departments = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie } })).json()) as {
      departments: { name_ar: string }[];
    };
    // Should have its own freshly-provisioned departments across all 6 service lines
    // (Inpatient alone is split into 5 wards).
    assert.equal(departments.departments.length, 10);

    const bank = (await (await fetch(`${baseUrl}/api/question-bank`, { headers: { cookie } })).json()) as {
      domains: unknown[];
      questions: unknown[];
    };
    assert.ok(bank.questions.length > 50, 'expected a full provisioned question bank');

    const comments = (await (await fetch(`${baseUrl}/api/comments`, { headers: { cookie } })).json()) as { comments: unknown[] };
    assert.equal(comments.comments.length, 0, 'a brand-new hospital must not see the demo tenant comments');
  } finally {
    server.close();
    db.close();
  }
});

test('two independently-registered hospitals never see each other data', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const hospitalA = await registerHospital(baseUrl, 'gamma');
    const hospitalB = await registerHospital(baseUrl, 'delta');

    const deptsA = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie: hospitalA.cookie } })).json()) as {
      departments: { id: string }[];
    };
    const deptsB = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie: hospitalB.cookie } })).json()) as {
      departments: { id: string }[];
    };

    const idsA = new Set(deptsA.departments.map((d) => d.id));
    const overlap = deptsB.departments.some((d) => idsA.has(d.id));
    assert.equal(overlap, false, 'department IDs must never overlap between tenants');
  } finally {
    server.close();
    db.close();
  }
});

test('phone-assisted survey submission is recorded and scoped correctly', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const { cookie } = await registerHospital(baseUrl, 'epsilon');
    const departments = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie } })).json()) as {
      departments: { id: string; service_type: string }[];
    };
    const templates = (await (await fetch(`${baseUrl}/api/templates`, { headers: { cookie } })).json()) as {
      templates: { id: string; service_type: string; questions: { id: string; answer_type: string; depends_on_code: string | null }[] }[];
    };
    const edDept = departments.departments.find((d) => d.service_type === 'ED')!;
    const edTemplate = templates.templates.find((t) => t.service_type === 'ED')!;
    const mainQuestion = edTemplate.questions.find((q) => !q.depends_on_code && q.answer_type === 'likert5')!;

    const submitRes = await fetch(`${baseUrl}/api/phone-survey/submit`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: edTemplate.id,
        departmentId: edDept.id,
        patientPhone: '0511111111',
        answers: [{ questionId: mainQuestion.id, value: 5 }],
        comment: undefined
      })
    });
    assert.equal(submitRes.status, 201);

    const invitation = db
      .prepare("SELECT channel, status FROM survey_invitations WHERE department_id = ? AND channel = 'phone'")
      .get(edDept.id) as { channel: string; status: string } | undefined;
    assert.ok(invitation);
    assert.equal(invitation!.status, 'completed');
  } finally {
    server.close();
    db.close();
  }
});
