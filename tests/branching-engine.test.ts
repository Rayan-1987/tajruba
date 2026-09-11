import { test } from 'node:test';
import assert from 'node:assert/strict';
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

// The original branching gate only ever meant "the gate question was answered yes" (an implicit
// eq-1 comparison). This exercises the generalized version: a follow-up that fires on a *low*
// rating instead (lte 2), proving the engine supports arbitrary operator/threshold pairs, not
// only the hardcoded yes/no ancillary-service gates it shipped with.
test('branching engine: a question can gate on any operator/value, not only "gate answered yes"', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');

    const domainRes = await fetch(`${baseUrl}/api/question-bank/domains`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ED_BRANCHTEST', nameAr: 'محور فرع تجريبي', nameEn: 'Branch Test', serviceType: 'ED', benchmarkTopBoxPercent: 80 })
    });
    assert.equal(domainRes.status, 201);
    const { id: domainId } = (await domainRes.json()) as { id: string };

    const gateRes = await fetch(`${baseUrl}/api/question-bank/questions`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'ED-BRANCH-GATE',
        domainId,
        textAr: 'كيف تقيّم وقت الانتظار؟',
        textEn: 'How do you rate the wait time?',
        type: 'likert5'
      })
    });
    assert.equal(gateRes.status, 201);

    // Only asked when the wait-time rating was low (<= 2) — the opposite shape from a yes/no
    // ancillary gate, and something the original hardcoded "=== 1" check could never express.
    const followUpRes = await fetch(`${baseUrl}/api/question-bank/questions`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'ED-BRANCH-FOLLOWUP',
        domainId,
        textAr: 'ما الذي أدى إلى طول الانتظار برأيك؟',
        textEn: 'What do you think caused the long wait?',
        type: 'text',
        dependsOnCode: 'ED-BRANCH-GATE',
        dependsOnOperator: 'lte',
        dependsOnValue: 2
      })
    });
    assert.equal(followUpRes.status, 201);
    const { id: followUpId } = (await followUpRes.json()) as { id: string };

    // Rejects an operator outside the supported set instead of silently storing garbage.
    const badOperatorRes = await fetch(`${baseUrl}/api/question-bank/questions`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'ED-BRANCH-BAD',
        domainId,
        textAr: 'سؤال',
        textEn: 'Question',
        type: 'text',
        dependsOnCode: 'ED-BRANCH-GATE',
        dependsOnOperator: 'contains'
      })
    });
    assert.equal(badOperatorRes.status, 400);

    const templatesRes = await fetch(`${baseUrl}/api/templates`, { headers: { cookie: adminCookie } });
    const templatesBody = (await templatesRes.json()) as {
      templates: {
        service_type: string;
        questions: { id: string; code: string; depends_on_code: string | null; depends_on_operator: string; depends_on_value: number }[];
      }[];
    };
    const edTemplate = templatesBody.templates.find((t) => t.service_type === 'ED')!;
    const followUpInTemplate = edTemplate.questions.find((q) => q.id === followUpId)!;
    assert.equal(followUpInTemplate.depends_on_code, 'ED-BRANCH-GATE');
    assert.equal(followUpInTemplate.depends_on_operator, 'lte');
    assert.equal(followUpInTemplate.depends_on_value, 2);

    // The same operator/value round-trips through the patient-facing survey token endpoint used
    // to actually render the branching survey (a pre-seeded, unexpired ED invitation).
    const publicRes = await fetch(`${baseUrl}/api/public/surveys/demo-ed-token`);
    assert.equal(publicRes.status, 200);
    const publicBody = (await publicRes.json()) as {
      questions: {
        id: string;
        code: string;
        answer_type: string;
        depends_on_code: string | null;
        depends_on_operator: string;
        depends_on_value: number;
      }[];
    };
    const publicFollowUp = publicBody.questions.find((q) => q.id === followUpId)!;
    assert.equal(publicFollowUp.depends_on_operator, 'lte');
    assert.equal(publicFollowUp.depends_on_value, 2);

    // A pre-existing yes/no ancillary gate (seeded during provisioning, e.g. Lab) must still
    // default to the original eq-1 semantics unchanged — the generalization must not silently
    // alter behavior for every gate that came before it.
    const legacyGate = publicBody.questions.find((q) => q.answer_type === 'yesno' && !q.depends_on_code);
    if (legacyGate) {
      const legacyFollowUp = publicBody.questions.find((q) => q.depends_on_code === legacyGate.code);
      if (legacyFollowUp) {
        assert.equal(legacyFollowUp.depends_on_operator, 'eq');
        assert.equal(legacyFollowUp.depends_on_value, 1);
      }
    }
  } finally {
    server.close();
    db.close();
  }
});
