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

interface TemplateQuestion {
  id: string;
  code: string;
  answer_type: string;
  depends_on_code: string | null;
}
interface Template {
  id: string;
  service_type: string;
  questions: TemplateQuestion[];
}
interface DeptRow {
  id: string;
  service_type: string;
  name_ar: string;
}

async function submitPhone(
  baseUrl: string,
  cookie: string,
  templateId: string,
  departmentId: string,
  phone: string,
  answers: { questionId: string; value: number }[]
) {
  const res = await fetch(`${baseUrl}/api/phone-survey/submit`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ templateId, departmentId, patientPhone: phone, answers })
  });
  assert.equal(res.status, 201);
}

test('reports/scores exposes per-question distribution, core/CAHPS flags, and period deltas', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const departments = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie: adminCookie } })).json()) as {
      departments: DeptRow[];
    };
    const templates = (await (await fetch(`${baseUrl}/api/templates`, { headers: { cookie: adminCookie } })).json()) as {
      templates: Template[];
    };
    const edDept = departments.departments.find((d) => d.service_type === 'ED')!;
    const edTemplate = templates.templates.find((t) => t.service_type === 'ED')!;
    const overallQ = edTemplate.questions.find((q) => q.code === 'ED-OVR-001')!;

    for (let i = 0; i < 10; i++) {
      await submitPhone(baseUrl, adminCookie, edTemplate.id, edDept.id, `05700000${i}`, [{ questionId: overallQ.id, value: (i % 5) + 1 }]);
    }

    const res = await fetch(`${baseUrl}/api/reports/scores?serviceType=ED`, { headers: { cookie: adminCookie } });
    const body = (await res.json()) as {
      domains: {
        domain: { code: string };
        questions: {
          code: string;
          isCustom: boolean;
          cahpsItem: boolean;
          distribution: { veryGoodPercent: number; goodPercent: number; fairPercent: number; poorPercent: number; veryPoorPercent: number } | null;
          vsLastPeriod: number | null;
          vs12MonthsAgo: number | null;
        }[];
      }[];
    };
    const overallDomain = body.domains.find((d) => d.domain.code === 'ED_OVR')!;
    const overallQuestion = overallDomain.questions.find((q) => q.code === 'ED-OVR-001')!;
    assert.equal(overallQuestion.isCustom, false, 'seeded question bank items are not custom');
    assert.equal(overallQuestion.cahpsItem, true, 'the Overall Assessment domain rating item is CAHPS-eligible');
    assert.ok(overallQuestion.distribution, 'a likert5 question reports a rating distribution');
    const sum =
      overallQuestion.distribution!.veryGoodPercent +
      overallQuestion.distribution!.goodPercent +
      overallQuestion.distribution!.fairPercent +
      overallQuestion.distribution!.poorPercent +
      overallQuestion.distribution!.veryPoorPercent;
    assert.ok(Math.abs(sum - 100) < 0.5, 'distribution buckets sum to ~100%');
    // Seed data only backdates responses up to 180 days, so the 12-months-ago rolling window
    // (365-450 days back) is guaranteed empty regardless of the random seed; the "vs last
    // period" window (90-180 days back) does overlap seeded demo data, so it may or may not be
    // null depending on the RNG — only its type is asserted here.
    assert.equal(overallQuestion.vs12MonthsAgo, null);
    assert.ok(overallQuestion.vsLastPeriod === null || typeof overallQuestion.vsLastPeriod === 'number');
  } finally {
    server.close();
  }
});

test('reports/priority-index ranks questions by correlation with the overall rating, and requires serviceType', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const departments = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie: adminCookie } })).json()) as {
      departments: DeptRow[];
    };
    const templates = (await (await fetch(`${baseUrl}/api/templates`, { headers: { cookie: adminCookie } })).json()) as {
      templates: Template[];
    };
    const edDept = departments.departments.find((d) => d.service_type === 'ED')!;
    const edTemplate = templates.templates.find((t) => t.service_type === 'ED')!;
    const overallQ = edTemplate.questions.find((q) => q.code === 'ED-OVR-001')!;
    const highCorrelationQ = edTemplate.questions.find((q) => q.answer_type === 'likert5' && q.code !== overallQ.code)!;

    const missingService = await fetch(`${baseUrl}/api/reports/priority-index`, { headers: { cookie: adminCookie } });
    assert.equal(missingService.status, 400);

    // Seed data already contributes ~40 randomized ED responses across every ED question, so a
    // large lockstep batch is submitted here to dominate that background noise and produce a
    // clearly-positive correlation signal for highCorrelationQ.
    for (let i = 0; i < 150; i++) {
      const value = (i % 5) + 1;
      await submitPhone(baseUrl, adminCookie, edTemplate.id, edDept.id, `05800${String(i).padStart(4, '0')}`, [
        { questionId: overallQ.id, value },
        { questionId: highCorrelationQ.id, value }
      ]);
    }

    const res = await fetch(`${baseUrl}/api/reports/priority-index?serviceType=ED`, { headers: { cookie: adminCookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { criterionQuestionId: string; items: { code: string; correlation: number | null; n: number }[] };
    assert.equal(body.criterionQuestionId, overallQ.id);
    const item = body.items.find((i) => i.code === highCorrelationQ.code);
    assert.ok(item, 'the perfectly-correlated question appears in the priority index');
    assert.ok(item!.correlation != null && item!.correlation > 0.5, 'a dominant lockstep signal still shows a strong positive correlation');
    assert.ok(item!.n >= 150);
  } finally {
    server.close();
  }
});

test('reports/departments-breakdown compares departments within a service and is forbidden to DepartmentManager', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const departments = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie: adminCookie } })).json()) as {
      departments: DeptRow[];
    };
    const templates = (await (await fetch(`${baseUrl}/api/templates`, { headers: { cookie: adminCookie } })).json()) as {
      templates: Template[];
    };
    const ipDepts = departments.departments.filter((d) => d.service_type === 'IP');
    assert.ok(ipDepts.length >= 2, 'seed data provisions multiple IP departments');
    const ipTemplate = templates.templates.find((t) => t.service_type === 'IP')!;
    const overallQ = ipTemplate.questions.find((q) => q.code === 'IP-OVR-001')!;

    // Seed data already scatters ~40 randomized IP responses per ward over the last 180 days
    // (of which only a fraction land in the "current" 90-day rolling window), so a large,
    // consistently high/low batch is submitted here to dominate that background noise.
    const [highDept, lowDept] = ipDepts;
    for (let i = 0; i < 60; i++) {
      await submitPhone(baseUrl, adminCookie, ipTemplate.id, highDept.id, `05900${String(i).padStart(4, '0')}`, [
        { questionId: overallQ.id, value: 5 }
      ]);
      await submitPhone(baseUrl, adminCookie, ipTemplate.id, lowDept.id, `05910${String(i).padStart(4, '0')}`, [
        { questionId: overallQ.id, value: 1 }
      ]);
    }

    const missingService = await fetch(`${baseUrl}/api/reports/departments-breakdown`, { headers: { cookie: adminCookie } });
    assert.equal(missingService.status, 400);

    const res = await fetch(`${baseUrl}/api/reports/departments-breakdown?serviceType=IP`, { headers: { cookie: adminCookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      orgAverageTopBoxPercent: number | null;
      departments: { departmentId: string; n: number; currentTopBoxPercent: number | null; deviationVsOrgAverage: number | null }[];
    };
    const highRow = body.departments.find((d) => d.departmentId === highDept.id)!;
    const lowRow = body.departments.find((d) => d.departmentId === lowDept.id)!;
    assert.ok(highRow.n >= 60 && lowRow.n >= 60);
    assert.ok((highRow.currentTopBoxPercent ?? 0) > (lowRow.currentTopBoxPercent ?? 0), 'the consistently top-rated department scores higher');
    assert.ok((highRow.deviationVsOrgAverage ?? 0) > (lowRow.deviationVsOrgAverage ?? 0));

    const deptManagerCookie = await login(baseUrl, 'department@tajruba.sa', 'Department123!');
    const forbidden = await fetch(`${baseUrl}/api/reports/departments-breakdown?serviceType=IP`, { headers: { cookie: deptManagerCookie } });
    assert.equal(forbidden.status, 403, 'a DepartmentManager cannot compare across departments they do not manage');
  } finally {
    server.close();
  }
});

test('reports/trend accepts a custom from/to date range and defaults to day-level buckets', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const departments = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie: adminCookie } })).json()) as {
      departments: DeptRow[];
    };
    const templates = (await (await fetch(`${baseUrl}/api/templates`, { headers: { cookie: adminCookie } })).json()) as {
      templates: Template[];
    };
    const edDept = departments.departments.find((d) => d.service_type === 'ED')!;
    const edTemplate = templates.templates.find((t) => t.service_type === 'ED')!;
    const overallQ = edTemplate.questions.find((q) => q.code === 'ED-OVR-001')!;
    await submitPhone(baseUrl, adminCookie, edTemplate.id, edDept.id, '0561111111', [{ questionId: overallQ.id, value: 5 }]);

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const res = await fetch(`${baseUrl}/api/reports/trend?serviceType=ED&from=${yesterday}&to=${tomorrow}`, { headers: { cookie: adminCookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { period: string; trend: { period: string; n: number }[] };
    assert.equal(body.period, 'day', 'a custom range with no explicit period defaults to day buckets');
    assert.ok(body.trend.some((t) => t.n >= 1));

    // Seed data backdates demo responses (never postdates them), so a window entirely in the
    // future is guaranteed to have no data regardless of the random seed — a recent-past window
    // is not safe to use here since seed's 180-day randomized spread can land inside it by chance.
    const outOfRange = await fetch(
      `${baseUrl}/api/reports/trend?serviceType=ED&from=${new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString()}&to=${new Date(
        Date.now() + 410 * 24 * 60 * 60 * 1000
      ).toISOString()}`,
      { headers: { cookie: adminCookie } }
    );
    const outOfRangeBody = (await outOfRange.json()) as { trend: unknown[] };
    assert.equal(outOfRangeBody.trend.length, 0, 'a date range with no possible data has no data');
  } finally {
    server.close();
  }
});

test('external benchmarks are manageable by SystemAdmin/QualityManager only, and upsert on repeat peer-group names', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const bank = (await (await fetch(`${baseUrl}/api/question-bank`, { headers: { cookie: adminCookie } })).json()) as {
      domains: { id: string; code: string }[];
    };
    const domain = bank.domains.find((d) => d.code === 'ED_OVR')!;

    const createRes = await fetch(`${baseUrl}/api/reports/benchmarks`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ domainId: domain.id, peerGroupName: 'GCC', value: 82.5 })
    });
    assert.equal(createRes.status, 201);

    // Same domain + peer group name again should update in place, not duplicate.
    const upsertRes = await fetch(`${baseUrl}/api/reports/benchmarks`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ domainId: domain.id, peerGroupName: 'GCC', value: 90 })
    });
    assert.equal(upsertRes.status, 200);

    const listRes = await fetch(`${baseUrl}/api/reports/benchmarks?domainId=${domain.id}`, { headers: { cookie: adminCookie } });
    const listBody = (await listRes.json()) as { benchmarks: { peerGroupName: string; value: number }[] };
    assert.equal(listBody.benchmarks.length, 1);
    assert.equal(listBody.benchmarks[0].value, 90);

    const scoresRes = await fetch(`${baseUrl}/api/reports/scores?serviceType=ED`, { headers: { cookie: adminCookie } });
    const scoresBody = (await scoresRes.json()) as { domains: { domain: { code: string }; benchmarks: { peerGroupName: string; value: number }[] }[] };
    const overallDomainScore = scoresBody.domains.find((d) => d.domain.code === 'ED_OVR')!;
    assert.deepEqual(overallDomainScore.benchmarks, [{ peerGroupName: 'GCC', value: 90 }]);

    const deptManagerCookie = await login(baseUrl, 'department@tajruba.sa', 'Department123!');
    const forbidden = await fetch(`${baseUrl}/api/reports/benchmarks`, {
      method: 'POST',
      headers: { cookie: deptManagerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ domainId: domain.id, peerGroupName: 'National', value: 70 })
    });
    assert.equal(forbidden.status, 403);
  } finally {
    server.close();
  }
});
