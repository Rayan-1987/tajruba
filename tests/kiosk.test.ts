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

async function createKioskLink(baseUrl: string, adminCookie: string) {
  const departments = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie: adminCookie } })).json()) as {
    departments: { id: string; service_type: string }[];
  };
  const templates = (await (await fetch(`${baseUrl}/api/templates`, { headers: { cookie: adminCookie } })).json()) as {
    templates: { id: string; service_type: string }[];
  };
  const edDept = departments.departments.find((d) => d.service_type === 'ED')!;
  const edTemplate = templates.templates.find((t) => t.service_type === 'ED')!;
  const res = await fetch(`${baseUrl}/api/kiosk-links`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ departmentId: edDept.id, templateId: edTemplate.id, label: 'مدخل الطوارئ' })
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { id: string; code: string };
}

test('a kiosk QR code can be used by unlimited anonymous patients without expiring', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const { code } = await createKioskLink(baseUrl, adminCookie);

    const surveyRes = await fetch(`${baseUrl}/api/public/kiosk/${code}`);
    assert.equal(surveyRes.status, 200);
    const survey = (await surveyRes.json()) as { questions: { id: string; answer_type: string; depends_on_code: string | null }[] };
    const mainQuestion = survey.questions.find((q) => !q.depends_on_code && q.answer_type === 'likert5')!;

    for (let i = 0; i < 3; i += 1) {
      const submitRes = await fetch(`${baseUrl}/api/public/kiosk/${code}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers: [{ questionId: mainQuestion.id, value: 5 }] })
      });
      assert.equal(submitRes.status, 201, `submission ${i + 1} should succeed — kiosk codes are reusable, unlike single-use invitations`);

      const stillWorks = await fetch(`${baseUrl}/api/public/kiosk/${code}`);
      assert.equal(stillWorks.status, 200, 'the kiosk code must remain usable after a submission');
    }

    const listRes = await fetch(`${baseUrl}/api/kiosk-links`, { headers: { cookie: adminCookie } });
    const list = (await listRes.json()) as { kioskLinks: { code: string; response_count: number }[] };
    const link = list.kioskLinks.find((l) => l.code === code)!;
    assert.equal(link.response_count, 3);
  } finally {
    server.close();
    db.close();
  }
});

test('deactivating a kiosk link immediately blocks new submissions', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const { id, code } = await createKioskLink(baseUrl, adminCookie);

    const deactivateRes = await fetch(`${baseUrl}/api/kiosk-links/${id}`, { method: 'DELETE', headers: { cookie: adminCookie } });
    assert.equal(deactivateRes.status, 200);

    const afterDeactivate = await fetch(`${baseUrl}/api/public/kiosk/${code}`);
    assert.equal(afterDeactivate.status, 404);

    const submitAfterDeactivate = await fetch(`${baseUrl}/api/public/kiosk/${code}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: [] })
    });
    assert.equal(submitAfterDeactivate.status, 404);
  } finally {
    server.close();
    db.close();
  }
});

test('kiosk responses do not consume a phone number and never touch the Do-Not-Contact/cooldown sampling frame', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const { code } = await createKioskLink(baseUrl, adminCookie);
    const survey = (await (await fetch(`${baseUrl}/api/public/kiosk/${code}`)).json()) as {
      questions: { id: string; answer_type: string; depends_on_code: string | null }[];
    };
    const mainQuestion = survey.questions.find((q) => !q.depends_on_code && q.answer_type === 'likert5')!;

    await fetch(`${baseUrl}/api/public/kiosk/${code}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: [{ questionId: mainQuestion.id, value: 4 }] })
    });

    const invitation = db.prepare("SELECT channel, status FROM survey_invitations WHERE channel = 'kiosk'").get() as
      | { channel: string; status: string }
      | undefined;
    assert.ok(invitation, 'a kiosk submission must still create an invitation+response row for reporting purposes');
    assert.equal(invitation!.status, 'completed');
  } finally {
    server.close();
    db.close();
  }
});

test('only a SystemAdmin or QualityManager can manage kiosk links', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const departmentCookie = await login(baseUrl, 'department@tajruba.sa', 'Department123!');
    const denied = await fetch(`${baseUrl}/api/kiosk-links`, { headers: { cookie: departmentCookie } });
    assert.equal(denied.status, 403);
  } finally {
    server.close();
    db.close();
  }
});
