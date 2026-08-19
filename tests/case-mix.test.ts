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
  return new Promise<{ server: Server; baseUrl: string }>((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
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

test('case-mix adjustment: no figure without age-band data, a well-formed one once submitted (RFP BMK-04)', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const templates = (await (await fetch(`${baseUrl}/api/templates`, { headers: { cookie: adminCookie } })).json()) as {
      templates: { id: string; service_type: string; questions: { id: string; code: string }[] }[];
    };
    const edTemplate = templates.templates.find((t) => t.service_type === 'ED')!;
    const overallQ = edTemplate.questions.find((q) => q.code === 'ED-OVR-001')!;

    // A freshly created department has none of the random seeded background demo responses,
    // so its own numbers here are fully attributable to what this test submits.
    const createDeptRes = await fetch(`${baseUrl}/api/departments`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ nameAr: 'قسم اختبار Case-mix', nameEn: 'Case-mix Test Dept', serviceType: 'ED' })
    });
    assert.equal(createDeptRes.status, 201);
    const { id: deptId } = (await createDeptRes.json()) as { id: string };

    const submitPhone = async (phone: string, value: number, ageBand?: string) => {
      const res = await fetch(`${baseUrl}/api/phone-survey/submit`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ templateId: edTemplate.id, departmentId: deptId, patientPhone: phone, ageBand, answers: [{ questionId: overallQ.id, value }] })
      });
      assert.equal(res.status, 201);
    };

    // Without any age-band data, case-mix adjustment has nothing to standardize against.
    for (let i = 0; i < 5; i++) {
      await submitPhone(`05900000${i}`, 5);
    }
    const before = (await (
      await fetch(`${baseUrl}/api/reports/departments-breakdown?serviceType=ED`, { headers: { cookie: adminCookie } })
    ).json()) as { departments: { departmentId: string; caseMixAdjustedTopBoxPercent: number | null }[] };
    const beforeDept = before.departments.find((d) => d.departmentId === deptId)!;
    assert.equal(beforeDept.caseMixAdjustedTopBoxPercent, null);

    // Now submit age-banded responses. A rejected invalid age band must not be accepted either.
    const rejected = await fetch(`${baseUrl}/api/phone-survey/submit`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: edTemplate.id,
        departmentId: deptId,
        patientPhone: '0599999999',
        ageBand: 'not-a-real-band',
        answers: [{ questionId: overallQ.id, value: 5 }]
      })
    });
    assert.equal(rejected.status, 400);

    for (let i = 0; i < 10; i++) {
      await submitPhone(`05910000${i}`, 5, '65+');
    }
    const after = (await (
      await fetch(`${baseUrl}/api/reports/departments-breakdown?serviceType=ED`, { headers: { cookie: adminCookie } })
    ).json()) as { departments: { departmentId: string; currentTopBoxPercent: number | null; caseMixAdjustedTopBoxPercent: number | null }[] };
    const afterDept = after.departments.find((d) => d.departmentId === deptId)!;
    assert.ok(afterDept.caseMixAdjustedTopBoxPercent !== null, 'an adjusted figure is now computed once age-band data exists');
    assert.ok(afterDept.caseMixAdjustedTopBoxPercent! >= 0 && afterDept.caseMixAdjustedTopBoxPercent! <= 100, 'adjusted figure stays within a valid percentage range');

    // Same figure must also be present in the CSV/Excel export.
    const exportRes = await fetch(`${baseUrl}/api/reports/departments-breakdown/export?format=csv&serviceType=ED`, { headers: { cookie: adminCookie } });
    assert.equal(exportRes.status, 200);
    const csvText = await exportRes.text();
    assert.ok(csvText.includes('Case-mix'), 'export header names the case-mix adjusted column');
  } finally {
    server.close();
  }
});
