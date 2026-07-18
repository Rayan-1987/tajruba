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

async function getKneePathwayAndDept(baseUrl: string, cookie: string) {
  const pathways = (await (await fetch(`${baseUrl}/api/proms/pathways`, { headers: { cookie } })).json()) as {
    pathways: { id: string; code: string; timepoints: { id: string; code: string }[] }[];
  };
  const pathway = pathways.pathways.find((p) => p.code === 'KNEE_REPLACEMENT')!;
  const departments = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie } })).json()) as {
    departments: { id: string; service_type: string }[];
  };
  const dept = departments.departments.find((d) => d.service_type === 'IP')!;
  return { pathway, deptId: dept.id };
}

test('creating an episode auto-generates an assignment per timepoint x instrument', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const { pathway, deptId } = await getKneePathwayAndDept(baseUrl, adminCookie);

    const res = await fetch(`${baseUrl}/api/episodes`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        pathwayId: pathway.id,
        departmentId: deptId,
        patientRef: 'MRN-TEST-001',
        contactPhone: '0511112222',
        surgeonRef: 'د. اختبار',
        startDate: new Date().toISOString().slice(0, 10)
      })
    });
    assert.equal(res.status, 201);
    const { id: episodeId } = (await res.json()) as { id: string };

    const assignmentCount = db.prepare('SELECT COUNT(*) as n FROM prom_assignments WHERE episode_id = ?').get(episodeId) as { n: number };
    assert.equal(assignmentCount.n, pathway.timepoints.length, 'one assignment per timepoint (single-instrument pathway)');

    const episode = db.prepare('SELECT contact_phone FROM patient_episodes WHERE id = ?').get(episodeId) as { contact_phone: string };
    assert.equal(episode.contact_phone, '0511112222');
  } finally {
    server.close();
    db.close();
  }
});

test('the baseline assignment appears in due-assignments and can be sent, generating a working patient link', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const { pathway, deptId } = await getKneePathwayAndDept(baseUrl, adminCookie);

    const episodeRes = await fetch(`${baseUrl}/api/episodes`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        pathwayId: pathway.id,
        departmentId: deptId,
        patientRef: 'MRN-TEST-002',
        contactPhone: '0511113333',
        startDate: new Date().toISOString().slice(0, 10)
      })
    });
    const { id: episodeId } = (await episodeRes.json()) as { id: string };

    const dueRes = await fetch(`${baseUrl}/api/proms/due-assignments`, { headers: { cookie: adminCookie } });
    const due = (await dueRes.json()) as { assignments: { id: string; episode_id: string; license_status: string }[] };
    const baselineAssignment = due.assignments.find((a) => a.episode_id === episodeId)!;
    assert.ok(baselineAssignment, 'the baseline (offsetDays=0) assignment must already be due');
    assert.equal(baselineAssignment.license_status, 'free');

    const sendRes = await fetch(`${baseUrl}/api/assignments/${baselineAssignment.id}/send`, {
      method: 'POST',
      headers: { cookie: adminCookie }
    });
    assert.equal(sendRes.status, 200);
    const sendBody = (await sendRes.json()) as { ok: boolean; sent: boolean };
    assert.equal(sendBody.sent, true);

    const assignmentRow = db.prepare('SELECT status, token_hash FROM prom_assignments WHERE id = ?').get(baselineAssignment.id) as {
      status: string;
      token_hash: string | null;
    };
    assert.equal(assignmentRow.status, 'sent');
    assert.ok(assignmentRow.token_hash);

    // Sending again must fail — a token was already issued.
    const secondSend = await fetch(`${baseUrl}/api/assignments/${baselineAssignment.id}/send`, {
      method: 'POST',
      headers: { cookie: adminCookie }
    });
    assert.equal(secondSend.status, 409);

    const afterSendDue = await fetch(`${baseUrl}/api/proms/due-assignments`, { headers: { cookie: adminCookie } });
    const afterSendBody = (await afterSendDue.json()) as { assignments: { episode_id: string }[] };
    assert.ok(!afterSendBody.assignments.some((a) => a.episode_id === episodeId), 'a sent assignment must drop off the due list');
  } finally {
    server.close();
    db.close();
  }
});

test('the patient can complete a free instrument via the public link, and scoring/baseline/MCID compute correctly across two timepoints', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const { pathway, deptId } = await getKneePathwayAndDept(baseUrl, adminCookie);

    const episodeRes = await fetch(`${baseUrl}/api/episodes`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        pathwayId: pathway.id,
        departmentId: deptId,
        patientRef: 'MRN-TEST-003',
        contactPhone: '0511114444',
        startDate: new Date().toISOString().slice(0, 10)
      })
    });
    const { id: episodeId } = (await episodeRes.json()) as { id: string };

    const orderedAssignments = db
      .prepare(
        `SELECT pa.id FROM prom_assignments pa JOIN pathway_timepoints pt ON pt.id = pa.timepoint_id
         WHERE pa.episode_id = ? ORDER BY pt.sort_order ASC LIMIT 2`
      )
      .all(episodeId) as { id: string }[];
    assert.equal(orderedAssignments.length, 2);

    const crypto = await import('node:crypto');
    function issueToken(assignmentId: string, rawToken: string) {
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      db.prepare("UPDATE prom_assignments SET token_hash = ?, status = 'sent', sent_at = datetime('now') WHERE id = ?").run(
        tokenHash,
        assignmentId
      );
    }

    // --- Baseline: high pain (8/10) ---
    issueToken(orderedAssignments[0].id, 'baseline-token');
    const baselineForm = (await (await fetch(`${baseUrl}/api/public/proms/baseline-token`)).json()) as {
      instrumentName: string;
      items: { code: string; scaleMax: number }[];
    };
    assert.equal(baselineForm.items.length, 1, 'VAS_PAIN has a single item');
    const baselineSubmit = await fetch(`${baseUrl}/api/public/proms/baseline-token/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: [{ code: baselineForm.items[0].code, value: 8 }] })
    });
    assert.equal(baselineSubmit.status, 201);
    const baselineResult = (await baselineSubmit.json()) as { raw: number; delta: number | null; mcidMet: boolean | null };
    assert.equal(baselineResult.raw, 8);
    assert.equal(baselineResult.delta, null, 'the baseline submission has no prior score to diff against');

    // Re-fetching the now-completed baseline token must reject.
    const baselineAgain = await fetch(`${baseUrl}/api/public/proms/baseline-token`);
    assert.equal(baselineAgain.status, 410);

    // --- W6 follow-up: pain dropped to 5/10 (a 3-point improvement, over VAS_PAIN's MCID of 2) ---
    issueToken(orderedAssignments[1].id, 'w6-token');
    const w6Form = (await (await fetch(`${baseUrl}/api/public/proms/w6-token`)).json()) as { items: { code: string }[] };
    const w6Submit = await fetch(`${baseUrl}/api/public/proms/w6-token/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: [{ code: w6Form.items[0].code, value: 5 }] })
    });
    assert.equal(w6Submit.status, 201);
    const w6Result = (await w6Submit.json()) as { raw: number; delta: number | null; mcidMet: boolean | null };
    assert.equal(w6Result.raw, 5);
    assert.equal(w6Result.delta, 3, 'baseline(8) - current(5) = 3-point improvement for a lower-is-better instrument');
    assert.equal(w6Result.mcidMet, true);

    // The outcomes dashboard endpoint must now show both scored timepoints for this episode.
    const outcomesRes = await fetch(`${baseUrl}/api/proms/outcomes?pathwayId=${pathway.id}`, { headers: { cookie: adminCookie } });
    const outcomes = (await outcomesRes.json()) as {
      episodes: { id: string; scores: { timepoint_code: string; raw_score: number; mcid_met: number | null }[] }[];
    };
    const thisEpisode = outcomes.episodes.find((e) => e.id === episodeId)!;
    assert.equal(thisEpisode.scores.length, 2);
  } finally {
    server.close();
    db.close();
  }
});

test('the public form rejects a licensed instrument and never leaks its real item text', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const pathways = (await (await fetch(`${baseUrl}/api/proms/pathways`, { headers: { cookie: adminCookie } })).json()) as {
      pathways: { id: string; code: string }[];
    };
    const instruments = (await (await fetch(`${baseUrl}/api/proms/instruments`, { headers: { cookie: adminCookie } })).json()) as {
      instruments: { id: string; code: string; license_status: string }[];
    };
    const licensedInstrument = instruments.instruments.find((i) => i.license_status === 'licensed_required')!;
    assert.ok(licensedInstrument, 'seed data must include at least one licensed instrument');

    // Fabricate a due assignment against a licensed instrument directly (bypassing pathway
    // config, since no seeded pathway uses a licensed instrument) to prove the API-level guard
    // works regardless of how such an assignment came to exist.
    const kneePathway = pathways.pathways.find((p) => p.code === 'KNEE_REPLACEMENT')!;
    const timepoint = db.prepare('SELECT id FROM pathway_timepoints WHERE pathway_id = ? LIMIT 1').get(kneePathway.id) as { id: string };
    const departments = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie: adminCookie } })).json()) as {
      departments: { id: string }[];
    };
    const episodeId = 'test-episode-licensed';
    db.prepare(
      `INSERT INTO patient_episodes (id, tenant_id, pathway_id, department_id, patient_ref_hash, contact_phone, start_date, status)
       VALUES (?, (SELECT tenant_id FROM users WHERE email = 'admin@tajruba.sa'), ?, ?, 'x', '0511115555', date('now'), 'active')`
    ).run(episodeId, kneePathway.id, departments.departments[0].id);
    const assignmentId = 'test-assignment-licensed';
    const rawToken = 'plaintext-test-token';
    const crypto = await import('node:crypto');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    db.prepare(
      `INSERT INTO prom_assignments (id, episode_id, timepoint_id, instrument_id, due_date, status, token_hash, sent_at)
       VALUES (?, ?, ?, ?, date('now'), 'sent', ?, datetime('now'))`
    ).run(assignmentId, episodeId, timepoint.id, licensedInstrument.id, tokenHash);

    const publicRes = await fetch(`${baseUrl}/api/public/proms/${rawToken}`);
    assert.equal(publicRes.status, 409);
    const body = (await publicRes.json()) as { error: string };
    assert.equal(body.error, 'instrument_requires_manual_administration');
  } finally {
    server.close();
    db.close();
  }
});

test('the HIS webhook can create an episode using the same API key as invitations', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const { pathway, deptId } = await getKneePathwayAndDept(baseUrl, adminCookie);

    const keyRes = await fetch(`${baseUrl}/api/settings/integrations/webhook-key/regenerate`, {
      method: 'POST',
      headers: { cookie: adminCookie }
    });
    const { key } = (await keyRes.json()) as { key: string };

    const res = await fetch(`${baseUrl}/api/webhooks/episodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Api-Key': key },
      body: JSON.stringify({
        pathwayId: pathway.id,
        departmentId: deptId,
        patientRef: 'MRN-HIS-001',
        contactPhone: '0511116666',
        startDate: new Date().toISOString().slice(0, 10)
      })
    });
    assert.equal(res.status, 201);
    const { id: episodeId } = (await res.json()) as { id: string };
    const episode = db.prepare('SELECT id FROM patient_episodes WHERE id = ?').get(episodeId);
    assert.ok(episode);

    const noKeyRes = await fetch(`${baseUrl}/api/webhooks/episodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pathwayId: pathway.id, departmentId: deptId, patientRef: 'x', startDate: '2026-01-01' })
    });
    assert.equal(noKeyRes.status, 401);
  } finally {
    server.close();
    db.close();
  }
});
