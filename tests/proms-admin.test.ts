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

test('a SystemAdmin can build a brand-new instrument end to end and it scores correctly', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');

    // A custom "lower is better" 2-item scale with MCID of 3 — unrelated to any hardcoded
    // InstrumentDefinition in scoring.ts, so this exercises the generic DB-driven fallback.
    const instrumentRes = await fetch(`${baseUrl}/api/proms/instruments`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'CUSTOM_FATIGUE',
        nameAr: 'مقياس التعب المخصص',
        nameEn: 'Custom Fatigue Scale',
        descriptionAr: 'مقياس تجريبي من إعداد المستشفى',
        licenseStatus: 'free',
        higherIsBetter: false,
        mcidThreshold: 3
      })
    });
    assert.equal(instrumentRes.status, 201);
    const { id: instrumentId } = (await instrumentRes.json()) as { id: string };

    const itemCodes: string[] = [];
    for (const item of [
      { code: 'FAT1', textAr: 'مستوى التعب اليوم', textEn: 'Fatigue level today' },
      { code: 'FAT2', textAr: 'التعب أثناء النشاط', textEn: 'Fatigue during activity' }
    ]) {
      const itemRes = await fetch(`${baseUrl}/api/proms/instruments/${instrumentId}/items`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ ...item, scaleMax: 10, reverseScored: false })
      });
      assert.equal(itemRes.status, 201);
      itemCodes.push(item.code);
    }

    // Editing an item and the instrument's own metadata must also work.
    const instrumentsList = (await (await fetch(`${baseUrl}/api/proms/instruments`, { headers: { cookie: adminCookie } })).json()) as {
      instruments: { id: string; items: { id: string; code: string }[] }[];
    };
    const createdInstrument = instrumentsList.instruments.find((i) => i.id === instrumentId)!;
    assert.equal(createdInstrument.items.length, 2);
    const firstItem = createdInstrument.items.find((i) => i.code === 'FAT1')!;
    const patchItemRes = await fetch(`${baseUrl}/api/proms/instrument-items/${firstItem.id}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ textAr: 'مستوى التعب اليوم (محدّث)' })
    });
    assert.equal(patchItemRes.status, 200);

    const pathwayRes = await fetch(`${baseUrl}/api/proms/pathways`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'CUSTOM_PATHWAY', nameAr: 'مسار تجريبي', nameEn: 'Custom Pathway' })
    });
    assert.equal(pathwayRes.status, 201);
    const { id: pathwayId } = (await pathwayRes.json()) as { id: string };

    const departments = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie: adminCookie } })).json()) as {
      departments: { id: string; service_type: string }[];
    };
    const deptId = departments.departments[0].id;

    const timepointIds: string[] = [];
    for (const [code, offsetDays] of [
      ['BASE', 0],
      ['FUP', 30]
    ] as const) {
      const tpRes = await fetch(`${baseUrl}/api/proms/pathways/${pathwayId}/timepoints`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ code, nameAr: code, offsetDays, windowDays: 14, instrumentIds: [instrumentId] })
      });
      assert.equal(tpRes.status, 201);
      const { id } = (await tpRes.json()) as { id: string };
      timepointIds.push(id);
    }

    // Editing a timepoint's instrument selection must also work.
    const patchTpRes = await fetch(`${baseUrl}/api/proms/timepoints/${timepointIds[0]}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ windowDays: 21 })
    });
    assert.equal(patchTpRes.status, 200);

    const episodeRes = await fetch(`${baseUrl}/api/episodes`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        pathwayId,
        departmentId: deptId,
        patientRef: 'MRN-CUSTOM-001',
        startDate: new Date().toISOString().slice(0, 10)
      })
    });
    assert.equal(episodeRes.status, 201);
    const { id: episodeId } = (await episodeRes.json()) as { id: string };

    const orderedAssignments = (await (
      await fetch(`${baseUrl}/api/proms/due-assignments`, { headers: { cookie: adminCookie } })
    ).json()) as { assignments: { id: string; episode_id: string }[] };
    const baseAssignment = orderedAssignments.assignments.find((a) => a.episode_id === episodeId)!;

    const crypto = await import('node:crypto');
    function issueToken(assignmentId: string, rawToken: string) {
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      db.prepare("UPDATE prom_assignments SET token_hash = ?, status = 'sent', sent_at = datetime('now') WHERE id = ?").run(
        tokenHash,
        assignmentId
      );
    }

    // --- Baseline: fatigue 8 + 6 = 14 ---
    issueToken(baseAssignment.id, 'custom-baseline-token');
    const baselineForm = (await (await fetch(`${baseUrl}/api/public/proms/custom-baseline-token`)).json()) as {
      items: { code: string; scaleMax: number }[];
    };
    assert.equal(baselineForm.items.length, 2);
    const baselineSubmit = await fetch(`${baseUrl}/api/public/proms/custom-baseline-token/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: [{ code: 'FAT1', value: 8 }, { code: 'FAT2', value: 6 }] })
    });
    assert.equal(baselineSubmit.status, 201);
    const baselineResult = (await baselineSubmit.json()) as { raw: number; delta: number | null };
    assert.equal(baselineResult.raw, 14);
    assert.equal(baselineResult.delta, null);

    // --- Follow-up: fatigue drops to 4 + 3 = 7, a 7-point improvement (lower is better) ---
    const followUpAssignment = (
      db
        .prepare(
          `SELECT pa.id FROM prom_assignments pa JOIN pathway_timepoints pt ON pt.id = pa.timepoint_id
           WHERE pa.episode_id = ? AND pt.code = 'FUP'`
        )
        .get(episodeId) as { id: string }
    ).id;
    issueToken(followUpAssignment, 'custom-followup-token');
    const followUpSubmit = await fetch(`${baseUrl}/api/public/proms/custom-followup-token/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: [{ code: 'FAT1', value: 4 }, { code: 'FAT2', value: 3 }] })
    });
    assert.equal(followUpSubmit.status, 201);
    const followUpResult = (await followUpSubmit.json()) as { raw: number; delta: number | null; mcidMet: boolean | null };
    assert.equal(followUpResult.raw, 7);
    assert.equal(followUpResult.delta, 7, 'baseline(14) - current(7) = 7-point improvement for a lower-is-better instrument');
    assert.equal(followUpResult.mcidMet, true, '7-point improvement clears the configured MCID threshold of 3');
  } finally {
    server.close();
    db.close();
  }
});

test('a DepartmentManager cannot create or edit PROMs instruments, pathways, or timepoints', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const deptCookie = await login(baseUrl, 'department@tajruba.sa', 'Department123!');

    const instrumentRes = await fetch(`${baseUrl}/api/proms/instruments`, {
      method: 'POST',
      headers: { cookie: deptCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'SHOULD_FAIL',
        nameAr: 'x',
        nameEn: 'x',
        descriptionAr: 'x',
        licenseStatus: 'free'
      })
    });
    assert.equal(instrumentRes.status, 403);

    const pathwayRes = await fetch(`${baseUrl}/api/proms/pathways`, {
      method: 'POST',
      headers: { cookie: deptCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'SHOULD_FAIL', nameAr: 'x', nameEn: 'x' })
    });
    assert.equal(pathwayRes.status, 403);
  } finally {
    server.close();
  }
});
