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

async function submitPhoneSurveyWithComplaint(baseUrl: string, adminCookie: string, opts: { contactOptIn: boolean; patientPhone: string }) {
  const departments = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie: adminCookie } })).json()) as {
    departments: { id: string; service_type: string }[];
  };
  const templates = (await (await fetch(`${baseUrl}/api/templates`, { headers: { cookie: adminCookie } })).json()) as {
    templates: { id: string; service_type: string; questions: { id: string; answer_type: string; depends_on_code: string | null }[] }[];
  };
  const edDept = departments.departments.find((d) => d.service_type === 'ED')!;
  const edTemplate = templates.templates.find((t) => t.service_type === 'ED')!;
  const mainQuestion = edTemplate.questions.find((q) => !q.depends_on_code && q.answer_type === 'likert5')!;

  const res = await fetch(`${baseUrl}/api/phone-survey/submit`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      templateId: edTemplate.id,
      departmentId: edDept.id,
      patientPhone: opts.patientPhone,
      answers: [{ questionId: mainQuestion.id, value: 2 }],
      comment: 'الخدمة كانت سيئة جدا واستغرقت وقتا طويلا',
      contactOptIn: opts.contactOptIn
    })
  });
  assert.equal(res.status, 201);
}

test('a patient who opts in is notified by SMS when their case is closed', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    await submitPhoneSurveyWithComplaint(baseUrl, adminCookie, { contactOptIn: true, patientPhone: '0544444444' });

    const cases = (await (await fetch(`${baseUrl}/api/service-recovery/cases`, { headers: { cookie: adminCookie } })).json()) as {
      cases: { id: string; comment_id: string; status: string; patient_contact_opt_in: number; patient_notified_at: string | null }[];
    };
    const openCase = cases.cases.find((c) => c.status === 'new')!;
    assert.equal(openCase.patient_contact_opt_in, 1);
    assert.equal(openCase.patient_notified_at, null);

    // Walk the case through assigned -> in_progress -> closed (closing requires QualityManager/SystemAdmin).
    await fetch(`${baseUrl}/api/comments/${openCase.comment_id}/status`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'assigned' })
    });
    await fetch(`${baseUrl}/api/comments/${openCase.comment_id}/status`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in_progress' })
    });
    const closeRes = await fetch(`${baseUrl}/api/comments/${openCase.comment_id}/status`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'closed', resolutionNotes: 'تم التواصل مع القسم وتصحيح الإجراء' })
    });
    assert.equal(closeRes.status, 200);
    const closeBody = (await closeRes.json()) as { patientNotified: boolean };
    assert.equal(closeBody.patientNotified, true);

    const casesAfter = (await (await fetch(`${baseUrl}/api/service-recovery/cases`, { headers: { cookie: adminCookie } })).json()) as {
      cases: { id: string; status: string; patient_notified_at: string | null }[];
    };
    const closedCase = casesAfter.cases.find((c) => c.id === openCase.id)!;
    assert.equal(closedCase.status, 'closed');
    assert.ok(closedCase.patient_notified_at, 'patient_notified_at must be set once the closure SMS is sent');
  } finally {
    server.close();
    db.close();
  }
});

test('a patient who does not opt in is never contacted, and closing a case is a no-op notification-wise', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    await submitPhoneSurveyWithComplaint(baseUrl, adminCookie, { contactOptIn: false, patientPhone: '0555555555' });

    const cases = (await (await fetch(`${baseUrl}/api/service-recovery/cases`, { headers: { cookie: adminCookie } })).json()) as {
      cases: { id: string; comment_id: string; status: string; patient_contact_opt_in: number }[];
    };
    const openCase = cases.cases.find((c) => c.status === 'new')!;
    assert.equal(openCase.patient_contact_opt_in, 0);

    await fetch(`${baseUrl}/api/comments/${openCase.comment_id}/status`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'assigned' })
    });
    await fetch(`${baseUrl}/api/comments/${openCase.comment_id}/status`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in_progress' })
    });
    const closeRes = await fetch(`${baseUrl}/api/comments/${openCase.comment_id}/status`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'closed' })
    });
    const closeBody = (await closeRes.json()) as { patientNotified: boolean };
    assert.equal(closeBody.patientNotified, false, 'no opt-in means no SMS is attempted');
  } finally {
    server.close();
    db.close();
  }
});

test('a case never gets notified twice, even if closed status is patched again', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    await submitPhoneSurveyWithComplaint(baseUrl, adminCookie, { contactOptIn: true, patientPhone: '0566666666' });

    const cases = (await (await fetch(`${baseUrl}/api/service-recovery/cases`, { headers: { cookie: adminCookie } })).json()) as {
      cases: { id: string; comment_id: string; status: string }[];
    };
    const openCase = cases.cases.find((c) => c.status === 'new')!;

    await fetch(`${baseUrl}/api/comments/${openCase.comment_id}/status`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'closed' })
    });
    const secondClose = await fetch(`${baseUrl}/api/comments/${openCase.comment_id}/status`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'closed' })
    });
    const secondBody = (await secondClose.json()) as { patientNotified: boolean };
    assert.equal(secondBody.patientNotified, false, 're-closing an already-notified case must not send a second SMS');
  } finally {
    server.close();
    db.close();
  }
});
