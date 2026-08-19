import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { openDatabase, type Db } from '../server/db.ts';
import { seedDatabase } from '../server/seed.ts';
import { createApi, escalateOverdueCases } from '../server/api.ts';

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

function makeCase(db: Db, tenantId: string, departmentId: string, dueAt: string | null): string {
  const invitation = db.prepare('SELECT id FROM survey_invitations WHERE tenant_id = ? AND department_id = ? LIMIT 1').get(tenantId, departmentId) as
    | { id: string }
    | undefined;
  if (!invitation) throw new Error('expected the seeded demo data to include at least one invitation for this department');
  const responseId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO survey_responses (id, invitation_id, tenant_id, started_at, submitted_at, language, mode) VALUES (?, ?, ?, datetime('now'), datetime('now'), 'ar', 'mobile')"
  ).run(responseId, invitation.id, tenantId);
  const commentId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO comments (id, response_id, tenant_id, department_id, raw_text, redacted_text) VALUES (?, ?, ?, ?, 'test', 'test')"
  ).run(commentId, responseId, tenantId, departmentId);
  db.prepare(
    "INSERT INTO comment_analyses (id, comment_id, sentiment, category, severity, analyzer) VALUES (?, ?, 'negative', 'other', 4, 'test')"
  ).run(crypto.randomUUID(), commentId);
  const caseId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO service_recovery_cases (id, comment_id, tenant_id, department_id, status, due_at) VALUES (?, ?, ?, ?, 'assigned', ?)"
  ).run(caseId, commentId, tenantId, departmentId, dueAt);
  return caseId;
}

test('service recovery escalation: levels rise the further a case is overdue, and stop at the max level', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const tenant = db.prepare('SELECT id FROM tenants LIMIT 1').get() as { id: string };
    const dept = db.prepare('SELECT id FROM departments WHERE tenant_id = ? LIMIT 1').get(tenant.id) as { id: string };

    // Not yet due: no escalation.
    const notYetDueCase = makeCase(db, tenant.id, dept.id, new Date(Date.now() + 60 * 60 * 1000).toISOString());
    // Overdue (by either a little or a lot — a single scheduler tick only ever escalates one
    // level at a time, matching how server.ts actually calls this on an interval): escalates to
    // level 1 (QualityManager) on the first tick.
    const justOverdueCase = makeCase(db, tenant.id, dept.id, new Date(Date.now() - 60 * 60 * 1000).toISOString());
    const wayOverdueCase = makeCase(db, tenant.id, dept.id, new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString());

    const first = escalateOverdueCases(db);
    assert.equal(first.escalated, 2, 'the two overdue cases escalate one level; the not-yet-due one does not');

    const levelsAfterFirst = db.prepare('SELECT id, escalation_level FROM service_recovery_cases').all() as { id: string; escalation_level: number }[];
    const levelById = (rows: typeof levelsAfterFirst) => new Map(rows.map((l) => [l.id, l.escalation_level]));
    assert.equal(levelById(levelsAfterFirst).get(notYetDueCase), 0);
    assert.equal(levelById(levelsAfterFirst).get(justOverdueCase), 1);
    assert.equal(levelById(levelsAfterFirst).get(wayOverdueCase), 1);

    const historyLevel1 = db.prepare('SELECT level, escalated_to_role FROM case_escalations WHERE case_id = ?').all(wayOverdueCase) as {
      level: number;
      escalated_to_role: string;
    }[];
    assert.equal(historyLevel1.length, 1);
    assert.equal(historyLevel1[0].level, 1);
    assert.equal(historyLevel1[0].escalated_to_role, 'QualityManager');

    // Running again shortly after: justOverdueCase is still only ~1 hour past due, well short of
    // the 24-hour threshold for level 2, so it stays at level 1 — only wayOverdueCase (30+ hours
    // overdue already) is eligible to advance further.
    const second = escalateOverdueCases(db);
    assert.equal(second.escalated, 1, 'only the far-overdue case is eligible to advance to level 2');

    const levelsAfterSecond = db.prepare('SELECT id, escalation_level FROM service_recovery_cases').all() as {
      id: string;
      escalation_level: number;
    }[];
    assert.equal(levelById(levelsAfterSecond).get(justOverdueCase), 1);
    assert.equal(levelById(levelsAfterSecond).get(wayOverdueCase), 2);

    const historyLevel2 = db.prepare('SELECT level, escalated_to_role FROM case_escalations WHERE case_id = ? ORDER BY level').all(wayOverdueCase) as {
      level: number;
      escalated_to_role: string;
    }[];
    assert.equal(historyLevel2.length, 2);
    assert.equal(historyLevel2[1].level, 2);
    assert.equal(historyLevel2[1].escalated_to_role, 'SystemAdmin');

    // wayOverdueCase is now at the max level (2) and must never escalate past it; justOverdueCase
    // still hasn't crossed the 24-hour threshold for level 2. Neither escalates further here.
    const third = escalateOverdueCases(db);
    assert.equal(third.escalated, 0);
    const stillAtMax = db.prepare('SELECT escalation_level FROM service_recovery_cases WHERE id = ?').get(wayOverdueCase) as {
      escalation_level: number;
    };
    assert.equal(stillAtMax.escalation_level, 2);

    // Improvement plan CRUD + linking a case to it (RFP SRC-06).
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const createRes = await fetch(`${baseUrl}/api/service-recovery/improvement-plans`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'تحسين وقت الاستجابة', correctiveAction: 'إضافة نوبة تمريض إضافية' })
    });
    assert.equal(createRes.status, 201);
    const { id: planId } = (await createRes.json()) as { id: string };

    const linkRes = await fetch(`${baseUrl}/api/service-recovery/cases/${wayOverdueCase}/link-plan`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ improvementPlanId: planId })
    });
    assert.equal(linkRes.status, 200);

    const casesRes = await fetch(`${baseUrl}/api/service-recovery/cases`, { headers: { cookie: adminCookie } });
    const casesBody = (await casesRes.json()) as { cases: { id: string; improvement_plan_id: string | null; improvement_plan_title: string | null }[] };
    const linkedCase = casesBody.cases.find((c) => c.id === wayOverdueCase)!;
    assert.equal(linkedCase.improvement_plan_id, planId);
    assert.equal(linkedCase.improvement_plan_title, 'تحسين وقت الاستجابة');

    const updateStatusRes = await fetch(`${baseUrl}/api/service-recovery/improvement-plans/${planId}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done', effectivenessNotes: 'انخفض متوسط زمن الاستجابة بنسبة ٤٠٪' })
    });
    assert.equal(updateStatusRes.status, 200);

    const plansRes = await fetch(`${baseUrl}/api/service-recovery/improvement-plans`, { headers: { cookie: adminCookie } });
    const plansBody = (await plansRes.json()) as { plans: { id: string; status: string; effectiveness_notes: string | null }[] };
    const updatedPlan = plansBody.plans.find((p) => p.id === planId)!;
    assert.equal(updatedPlan.status, 'done');
    assert.equal(updatedPlan.effectiveness_notes, 'انخفض متوسط زمن الاستجابة بنسبة ٤٠٪');
  } finally {
    server.close();
  }
});
