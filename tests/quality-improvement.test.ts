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

const PHASE_ORDER = ['FIND', 'ORGANIZE', 'CLARIFY', 'UNDERSTAND', 'SELECT', 'PLAN', 'DO', 'CHECK', 'ACT'];

test('QI project creation auto-provisions all nine FOCUS-PDCA phases with FIND already in progress', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');

    const createRes = await fetch(`${baseUrl}/api/qi-projects`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'تقليل وقت الانتظار بالطوارئ', problemStatement: 'انتظار طويل قبل الفرز' })
    });
    assert.equal(createRes.status, 201);
    const { id } = (await createRes.json()) as { id: string };

    const detailRes = await fetch(`${baseUrl}/api/qi-projects/${id}`, { headers: { cookie: adminCookie } });
    assert.equal(detailRes.status, 200);
    const detail = (await detailRes.json()) as {
      project: { title: string; status: string };
      phases: { phase_code: string; sort_order: number; status: string }[];
      team: unknown[];
      cycles: unknown[];
    };
    assert.equal(detail.project.title, 'تقليل وقت الانتظار بالطوارئ');
    assert.equal(detail.phases.length, 9);
    assert.deepEqual(
      detail.phases.map((p) => p.phase_code),
      PHASE_ORDER
    );
    assert.equal(detail.phases[0].status, 'in_progress', 'FIND starts in_progress so the tracker always shows one active step');
    for (const p of detail.phases.slice(1)) assert.equal(p.status, 'pending');
    assert.equal(detail.team.length, 0);
    assert.equal(detail.cycles.length, 0);
  } finally {
    server.close();
  }
});

test('QI project: marking a phase done auto-advances the next pending phase to in_progress', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const { id } = (await (
      await fetch(`${baseUrl}/api/qi-projects`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'مشروع تجريبي' })
      })
    ).json()) as { id: string };

    const doneRes = await fetch(`${baseUrl}/api/qi-projects/${id}/phases/FIND`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done', notes: 'تم تحديد المشكلة' })
    });
    assert.equal(doneRes.status, 200);

    const detail = (await (await fetch(`${baseUrl}/api/qi-projects/${id}`, { headers: { cookie: adminCookie } })).json()) as {
      phases: { phase_code: string; status: string; notes: string | null; completed_at: string | null }[];
    };
    const find = detail.phases.find((p) => p.phase_code === 'FIND')!;
    const organize = detail.phases.find((p) => p.phase_code === 'ORGANIZE')!;
    const clarify = detail.phases.find((p) => p.phase_code === 'CLARIFY')!;
    assert.equal(find.status, 'done');
    assert.equal(find.notes, 'تم تحديد المشكلة');
    assert.ok(find.completed_at);
    assert.equal(organize.status, 'in_progress', 'the next phase in order auto-advances');
    assert.equal(clarify.status, 'pending', 'phases beyond the next one stay untouched');

    // Rejects a phase code that isn't one of the nine.
    const badPhase = await fetch(`${baseUrl}/api/qi-projects/${id}/phases/BOGUS`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' })
    });
    assert.equal(badPhase.status, 400);
  } finally {
    server.close();
  }
});

test('QI project: team roster add/remove and PDCA cycles with before/after metrics', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const { id } = (await (
      await fetch(`${baseUrl}/api/qi-projects`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'مشروع الفريق والدورات' })
      })
    ).json()) as { id: string };

    const memberRes = await fetch(`${baseUrl}/api/qi-projects/${id}/team`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'د. سارة أحمد', roleLabel: 'قائدة الفريق' })
    });
    assert.equal(memberRes.status, 201);
    const { id: memberId } = (await memberRes.json()) as { id: string };

    type QiDetail = { team: { id: string; name: string; role_label: string | null }[]; cycles: { id: string; cycle_number: number }[] };
    const fetchDetail = async () =>
      (await (await fetch(`${baseUrl}/api/qi-projects/${id}`, { headers: { cookie: adminCookie } })).json()) as QiDetail;

    const detailWithMember = await fetchDetail();
    assert.equal(detailWithMember.team.length, 1);
    assert.equal(detailWithMember.team[0].name, 'د. سارة أحمد');

    await fetch(`${baseUrl}/api/qi-projects/${id}/team/${memberId}`, { method: 'DELETE', headers: { cookie: adminCookie } });
    const detailAfterRemove = await fetchDetail();
    assert.equal(detailAfterRemove.team.length, 0);

    const cycle1Res = await fetch(`${baseUrl}/api/qi-projects/${id}/cycles`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ metricLabel: 'Top Box % الانتظار', baselineValue: 40 })
    });
    assert.equal(cycle1Res.status, 201);
    const { id: cycle1Id, cycleNumber: cycle1Number } = (await cycle1Res.json()) as { id: string; cycleNumber: number };
    assert.equal(cycle1Number, 1);

    await fetch(`${baseUrl}/api/qi-projects/${id}/cycles/${cycle1Id}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ planNotes: 'إعادة توزيع الطاقم', doNotes: 'تم التنفيذ لمدة شهر', resultValue: 55 })
    });

    // A second cycle gets the next sequential number.
    const cycle2Res = await fetch(`${baseUrl}/api/qi-projects/${id}/cycles`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ metricLabel: 'Top Box % الانتظار', baselineValue: 55 })
    });
    const { cycleNumber: cycle2Number } = (await cycle2Res.json()) as { cycleNumber: number };
    assert.equal(cycle2Number, 2);

    await fetch(`${baseUrl}/api/qi-projects/${id}/cycles/${cycle1Id}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'completed' })
    });

    const finalDetail = (await (await fetch(`${baseUrl}/api/qi-projects/${id}`, { headers: { cookie: adminCookie } })).json()) as {
      team: unknown[];
      cycles: { id: string; cycle_number: number; baseline_value: number; result_value: number | null; plan_notes: string | null; status: string; completed_at: string | null }[];
    };
    assert.equal(finalDetail.cycles.length, 2);
    const c1 = finalDetail.cycles.find((c) => c.cycle_number === 1)!;
    assert.equal(c1.baseline_value, 40);
    assert.equal(c1.result_value, 55);
    assert.equal(c1.plan_notes, 'إعادة توزيع الطاقم');
    assert.equal(c1.status, 'completed');
    assert.ok(c1.completed_at);
    const c2 = finalDetail.cycles.find((c) => c.cycle_number === 2)!;
    assert.equal(c2.baseline_value, 55);
    assert.equal(c2.status, 'open');
  } finally {
    server.close();
  }
});

test('QI project: a DepartmentManager is scoped to their own department and blocked from others', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const deptCookie = await login(baseUrl, 'department@tajruba.sa', 'Department123!');

    const deptRow = db.prepare("SELECT department_id FROM users WHERE email = 'department@tajruba.sa'").get() as { department_id: string };
    const otherDept = db.prepare('SELECT id FROM departments WHERE id != ? LIMIT 1').get(deptRow.department_id) as { id: string };

    // The department manager can create and read a project scoped to their own department.
    const ownProjectRes = await fetch(`${baseUrl}/api/qi-projects`, {
      method: 'POST',
      headers: { cookie: deptCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'مشروع القسم الخاص بي', departmentId: deptRow.department_id })
    });
    assert.equal(ownProjectRes.status, 201);
    const { id: ownId } = (await ownProjectRes.json()) as { id: string };
    const ownDetailRes = await fetch(`${baseUrl}/api/qi-projects/${ownId}`, { headers: { cookie: deptCookie } });
    assert.equal(ownDetailRes.status, 200);

    // But is rejected trying to create a project under a different department...
    const crossCreateRes = await fetch(`${baseUrl}/api/qi-projects`, {
      method: 'POST',
      headers: { cookie: deptCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'مشروع قسم آخر', departmentId: otherDept.id })
    });
    assert.equal(crossCreateRes.status, 403);

    // ...and blocked from reading a project an admin created under that other department.
    const { id: otherId } = (await (
      await fetch(`${baseUrl}/api/qi-projects`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'مشروع قسم مختلف', departmentId: otherDept.id })
      })
    ).json()) as { id: string };
    const crossReadRes = await fetch(`${baseUrl}/api/qi-projects/${otherId}`, { headers: { cookie: deptCookie } });
    assert.equal(crossReadRes.status, 403);

    // The department manager's project list is also scoped to only their own department.
    const listRes = await fetch(`${baseUrl}/api/qi-projects`, { headers: { cookie: deptCookie } });
    const listBody = (await listRes.json()) as { projects: { id: string; department_id: string | null }[] };
    assert.ok(listBody.projects.every((p) => p.department_id === deptRow.department_id));
    assert.ok(listBody.projects.some((p) => p.id === ownId));
    assert.ok(!listBody.projects.some((p) => p.id === otherId));
  } finally {
    server.close();
  }
});
