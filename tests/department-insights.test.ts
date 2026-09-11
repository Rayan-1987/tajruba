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

interface DepartmentInsights {
  department: { id: string; nameAr: string; serviceType: string };
  domainScores: { domainId: string; nameAr: string; n: number; topBoxPercent: number | null }[];
  sentimentCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  commentCount: number;
  serviceRecovery: { openCases: number; overdueCases: number; escalatedCases: number };
  qiProjects: { id: string; title: string; phasesDone: number }[];
  findings: string[];
  recommendQiProject: boolean;
}

test('department insights: synthesizes domain scores, comment mix, and service-recovery load for a real seeded department', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const edDept = db.prepare("SELECT id, name_ar FROM departments WHERE service_type = 'ED' LIMIT 1").get() as { id: string; name_ar: string };

    const res = await fetch(`${baseUrl}/api/department-insights/${edDept.id}`, { headers: { cookie: adminCookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as DepartmentInsights;

    assert.equal(body.department.id, edDept.id);
    assert.equal(body.department.nameAr, edDept.name_ar);
    assert.equal(body.department.serviceType, 'ED');
    assert.ok(body.domainScores.length > 0, 'ED has multiple question domains, all should be scored');
    assert.ok(body.findings.length > 0, 'always returns at least a fallback finding, never an empty list');
    assert.equal(typeof body.commentCount, 'number');
    assert.equal(typeof body.serviceRecovery.openCases, 'number');
    assert.equal(typeof body.recommendQiProject, 'boolean');

    // commentCount must equal the sum of sentimentCounts, and every category count together
    // must also sum to commentCount (each analyzed comment has exactly one sentiment and category).
    const sentimentSum = Object.values(body.sentimentCounts).reduce((a, b) => a + b, 0);
    const categorySum = Object.values(body.categoryCounts).reduce((a, b) => a + b, 0);
    assert.equal(sentimentSum, body.commentCount);
    assert.equal(categorySum, body.commentCount);
  } finally {
    server.close();
  }
});

test('department insights: 404 for a foreign/unknown department, 403 for a DepartmentManager outside their own department', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const deptCookie = await login(baseUrl, 'department@tajruba.sa', 'Department123!');

    const notFoundRes = await fetch(`${baseUrl}/api/department-insights/does-not-exist`, { headers: { cookie: adminCookie } });
    assert.equal(notFoundRes.status, 404);

    const deptRow = db.prepare("SELECT department_id FROM users WHERE email = 'department@tajruba.sa'").get() as { department_id: string };
    const otherDept = db.prepare('SELECT id FROM departments WHERE id != ? LIMIT 1').get(deptRow.department_id) as { id: string };

    const ownRes = await fetch(`${baseUrl}/api/department-insights/${deptRow.department_id}`, { headers: { cookie: deptCookie } });
    assert.equal(ownRes.status, 200);

    const crossRes = await fetch(`${baseUrl}/api/department-insights/${otherDept.id}`, { headers: { cookie: deptCookie } });
    assert.equal(crossRes.status, 403);
  } finally {
    server.close();
  }
});

test('department insights: an active QI project for the department is surfaced and suppresses the "open a project" nudge', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const edDept = db.prepare("SELECT id FROM departments WHERE service_type = 'ED' LIMIT 1").get() as { id: string };

    const before = (await (
      await fetch(`${baseUrl}/api/department-insights/${edDept.id}`, { headers: { cookie: adminCookie } })
    ).json()) as DepartmentInsights;
    assert.equal(before.qiProjects.length, 0);

    const createRes = await fetch(`${baseUrl}/api/qi-projects`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'تقليل وقت الانتظار', departmentId: edDept.id })
    });
    const { id: projectId } = (await createRes.json()) as { id: string };

    const after = (await (
      await fetch(`${baseUrl}/api/department-insights/${edDept.id}`, { headers: { cookie: adminCookie } })
    ).json()) as DepartmentInsights;
    assert.equal(after.qiProjects.length, 1);
    assert.equal(after.qiProjects[0].id, projectId);
    assert.equal(after.qiProjects[0].phasesDone, 0);
    assert.equal(after.recommendQiProject, false, 'an active project already exists, so the nudge to open one must not fire');
    assert.ok(after.findings.some((f) => f.includes('مشروع تحسين جودة نشط')));
  } finally {
    server.close();
  }
});
