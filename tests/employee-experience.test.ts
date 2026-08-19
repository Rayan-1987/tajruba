import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { openDatabase, type Db } from '../server/db.ts';
import { seedDatabase } from '../server/seed.ts';
import { createApi } from '../server/api.ts';

const root = new URL('..', import.meta.url).pathname;

function startServer() {
  const db = openDatabase(':memory:');
  seedDatabase(db, root);
  const app = express();
  app.use('/api', createApi(db, 'test-secret-at-least-32-characters-long', root));
  return new Promise<{ server: Server; baseUrl: string; db: Db }>((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, db });
    });
  });
}

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(res.status, 200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

test('employee experience: default instruments are seeded, submission is anonymous, and small groups are suppressed', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');

    const instrumentsRes = await fetch(`${baseUrl}/api/employee-experience/instruments`, { headers: { cookie: adminCookie } });
    assert.equal(instrumentsRes.status, 200);
    const { instruments } = (await instrumentsRes.json()) as { instruments: { id: string; code: string; kind: string }[] };
    const annual = instruments.find((i) => i.code === 'EES_ANNUAL');
    assert.ok(annual, 'the default annual employee instrument is provisioned');
    assert.ok(instruments.some((i) => i.code === 'EES_PULSE'), 'the default pulse employee instrument is provisioned');

    const structureRes = await fetch(`${baseUrl}/api/employee-experience/instruments/${annual!.id}/structure`, { headers: { cookie: adminCookie } });
    assert.equal(structureRes.status, 200);
    const structure = (await structureRes.json()) as { domains: { id: string; is_driver: number; questions: { id: string }[] }[] };
    assert.ok(structure.domains.length >= 5, 'annual instrument has multiple driver domains plus an overall domain');
    const allQuestionIds = structure.domains.flatMap((d) => d.questions.map((q) => q.id));
    assert.ok(allQuestionIds.length > 0);

    // Roster + invitation flow.
    const addEmployeeRes = await fetch(`${baseUrl}/api/employee-experience/employees`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ jobCategory: 'Nursing', contactChannel: 'email', contactValue: 'nurse1@hospital.sa' })
    });
    assert.equal(addEmployeeRes.status, 201);

    const inviteRes = await fetch(`${baseUrl}/api/employee-experience/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ instrumentId: annual!.id })
    });
    assert.equal(inviteRes.status, 201);
    const { sent } = (await inviteRes.json()) as { sent: number };
    assert.equal(sent, 1);

    // Simulate knowing the raw token the employee received (only its hash is stored server-side,
    // same pattern as tests/proms.test.ts) so the public anonymous-submit endpoint can be exercised.
    const rawToken = 'employee-test-token';
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    db.prepare('UPDATE employee_survey_invitations SET token_hash = ? WHERE instrument_id = ?').run(tokenHash, annual!.id);

    const publicForm = await fetch(`${baseUrl}/api/public/employee-survey/${rawToken}`);
    assert.equal(publicForm.status, 200);
    const formBody = (await publicForm.json()) as { domains: { questions: { id: string }[] }[] };
    const formQuestionIds = formBody.domains.flatMap((d) => d.questions.map((q) => q.id));
    assert.deepEqual(new Set(formQuestionIds), new Set(allQuestionIds));

    const submitRes = await fetch(`${baseUrl}/api/public/employee-survey/${rawToken}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: formQuestionIds.map((id) => ({ questionId: id, value: 5 })) })
    });
    assert.equal(submitRes.status, 201);

    // The submitted response must carry no employee/invitation identifier at all.
    const responseRow = db
      .prepare('SELECT * FROM employee_survey_responses WHERE instrument_id = ?')
      .get(annual!.id) as Record<string, unknown>;
    assert.ok(!('employee_id' in responseRow));
    assert.ok(!('invitation_id' in responseRow));

    // Re-submitting the same (now completed) token must be rejected.
    const resubmit = await fetch(`${baseUrl}/api/public/employee-survey/${rawToken}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: formQuestionIds.map((id) => ({ questionId: id, value: 5 })) })
    });
    assert.equal(resubmit.status, 410);

    // With only 1 respondent, the dashboard must suppress figures below the confidentiality floor.
    const dashboardSmall = (await (
      await fetch(`${baseUrl}/api/employee-experience/dashboard?instrumentId=${annual!.id}`, { headers: { cookie: adminCookie } })
    ).json()) as { suppressed: boolean; n: number };
    assert.equal(dashboardSmall.suppressed, true);
    assert.equal(dashboardSmall.n, 1);

    // Backfill 4 more anonymous responses directly (bypassing the invitation flow, since only the
    // response volume matters for this assertion) to cross the confidentiality floor.
    const insertResponse = db.prepare(
      'INSERT INTO employee_survey_responses (id, tenant_id, instrument_id, department_id, job_category, submitted_at) VALUES (?, ?, ?, NULL, ?, datetime(\'now\'))'
    );
    const insertAnswer = db.prepare('INSERT INTO employee_survey_answers (id, response_id, question_id, value_numeric) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 4; i += 1) {
      const responseId = crypto.randomUUID();
      insertResponse.run(responseId, responseRow.tenant_id as string, annual!.id, 'Nursing');
      for (const questionId of allQuestionIds) {
        insertAnswer.run(crypto.randomUUID(), responseId, questionId, 4);
      }
    }

    const dashboardFull = (await (
      await fetch(`${baseUrl}/api/employee-experience/dashboard?instrumentId=${annual!.id}`, { headers: { cookie: adminCookie } })
    ).json()) as { suppressed: boolean; n: number; staffSatisfactionScore: number | null; engagementScore: number | null };
    assert.equal(dashboardFull.suppressed, false);
    assert.equal(dashboardFull.n, 5);
    assert.ok(dashboardFull.staffSatisfactionScore !== null);
    assert.ok(dashboardFull.engagementScore !== null);

    // Improvement plan CRUD.
    const planRes = await fetch(`${baseUrl}/api/employee-experience/improvement-plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ title: 'تحسين التواصل الإداري' })
    });
    assert.equal(planRes.status, 201);
    const { id: planId } = (await planRes.json()) as { id: string };
    const patchRes = await fetch(`${baseUrl}/api/employee-experience/improvement-plans/${planId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ status: 'in_progress' })
    });
    assert.equal(patchRes.status, 200);
  } finally {
    server.close();
  }
});
