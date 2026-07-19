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

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(res.status, 200);
  return extractCookie(res);
}

test('comments carry the department service_type and the provider named at invite time, and both are filterable', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const departments = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie: adminCookie } })).json()) as {
      departments: { id: string; service_type: string }[];
    };
    const templates = (await (await fetch(`${baseUrl}/api/templates`, { headers: { cookie: adminCookie } })).json()) as {
      templates: { id: string; service_type: string; questions: { id: string; answer_type: string; depends_on_code: string | null }[] }[];
    };
    const edDept = departments.departments.find((d) => d.service_type === 'ED')!;
    const edTemplate = templates.templates.find((t) => t.service_type === 'ED')!;
    const mainQuestion = edTemplate.questions.find((q) => !q.depends_on_code && q.answer_type === 'likert5')!;

    // Two comments in the same service, different named providers, via the phone-survey path.
    await fetch(`${baseUrl}/api/phone-survey/submit`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: edTemplate.id,
        departmentId: edDept.id,
        patientPhone: '0566666601',
        providerName: 'د. أحمد الشمري',
        answers: [{ questionId: mainQuestion.id, value: 2 }],
        comment: 'تعليق تجريبي عن د. أحمد الشمري'
      })
    });
    await fetch(`${baseUrl}/api/phone-survey/submit`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: edTemplate.id,
        departmentId: edDept.id,
        patientPhone: '0566666602',
        providerName: 'د. سارة العتيبي',
        answers: [{ questionId: mainQuestion.id, value: 1 }],
        comment: 'تعليق تجريبي عن د. سارة العتيبي'
      })
    });
    // A third comment via the bulk-invitation + public-submit path, with no provider name at all.
    const inviteRes = await fetch(`${baseUrl}/api/invitations/bulk`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: edTemplate.id,
        departmentId: edDept.id,
        channel: 'sms',
        rows: [{ phone: '0566666603' }]
      })
    });
    assert.equal(inviteRes.status, 201);

    const allRes = await fetch(`${baseUrl}/api/comments?serviceType=ED`, { headers: { cookie: adminCookie } });
    const all = (await allRes.json()) as {
      comments: { redacted_text: string; service_type: string; provider_name: string | null; department_name_ar: string }[];
    };
    const ours = all.comments.filter((c) => c.redacted_text.includes('تجريبي'));
    assert.equal(ours.length, 2, 'only the two comments submitted with an actual comment body should appear');
    assert.ok(ours.every((c) => c.service_type === 'ED'));
    assert.ok(ours.every((c) => c.department_name_ar));
    const providerNames = ours.map((c) => c.provider_name).sort();
    assert.deepEqual(providerNames, ['د. أحمد الشمري', 'د. سارة العتيبي']);

    // Filter by provider name (partial match).
    const filteredRes = await fetch(`${baseUrl}/api/comments?providerName=${encodeURIComponent('أحمد')}`, {
      headers: { cookie: adminCookie }
    });
    const filtered = (await filteredRes.json()) as { comments: { provider_name: string | null }[] };
    assert.ok(filtered.comments.length >= 1);
    assert.ok(filtered.comments.every((c) => c.provider_name?.includes('أحمد')));

    // Filter by a service with none of our seeded comments — must come back empty.
    const wrongServiceRes = await fetch(`${baseUrl}/api/comments?serviceType=BB`, { headers: { cookie: adminCookie } });
    const wrongService = (await wrongServiceRes.json()) as { comments: { redacted_text: string }[] };
    assert.ok(!wrongService.comments.some((c) => c.redacted_text.includes('تجريبي')));
  } finally {
    server.close();
  }
});
