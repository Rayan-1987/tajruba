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

interface RateBucket {
  total: number;
  completed: number;
  notYetResponded: number;
  failedToSend: number;
  responseRatePercent: number | null;
  deliveredResponseRatePercent: number | null;
}
interface ResponseRateReport {
  overall: RateBucket;
  byDepartment: (RateBucket & { departmentId: string; nameAr: string })[];
  byChannel: (RateBucket & { channel: string })[];
}

test('response rate: counts completed/pending/sent invitations correctly and excludes kiosk/phone channels', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const dept = db.prepare("SELECT id, name_ar FROM departments WHERE service_type = 'IP' LIMIT 1").get() as { id: string; name_ar: string };
    const tpl = db.prepare("SELECT id FROM survey_templates WHERE service_type = 'IP' LIMIT 1").get() as { id: string };

    const before = (
      await (await fetch(`${baseUrl}/api/reports/response-rate?departmentId=${dept.id}`, { headers: { cookie: adminCookie } })).json()
    ) as ResponseRateReport;

    const insertInvitation = db.prepare(
      `INSERT INTO survey_invitations (id, tenant_id, template_id, department_id, service_type, token_hash, patient_phone_hash, channel, status, expires_at, created_at)
       VALUES (?, (SELECT tenant_id FROM departments WHERE id = ?), ?, ?, 'IP', ?, ?, ?, ?, datetime('now','+14 days'), datetime('now'))`
    );
    const rawId = () => crypto.randomUUID();
    const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

    // Two completed, one still sent (awaiting response), one failed to send -- all SMS, plus one
    // completed kiosk invitation that must NOT count toward this report at all.
    insertInvitation.run(rawId(), dept.id, tpl.id, dept.id, hash(rawId()), hash(rawId()), 'sms', 'completed');
    insertInvitation.run(rawId(), dept.id, tpl.id, dept.id, hash(rawId()), hash(rawId()), 'sms', 'completed');
    insertInvitation.run(rawId(), dept.id, tpl.id, dept.id, hash(rawId()), hash(rawId()), 'sms', 'sent');
    insertInvitation.run(rawId(), dept.id, tpl.id, dept.id, hash(rawId()), hash(rawId()), 'sms', 'pending');
    insertInvitation.run(rawId(), dept.id, tpl.id, dept.id, hash(rawId()), hash(rawId()), 'kiosk', 'completed');

    const after = (
      await (await fetch(`${baseUrl}/api/reports/response-rate?departmentId=${dept.id}`, { headers: { cookie: adminCookie } })).json()
    ) as ResponseRateReport;

    // Exactly the 4 non-kiosk rows were counted, not the 5th (kiosk) one.
    assert.equal(after.overall.total - before.overall.total, 4);
    assert.equal(after.overall.completed - before.overall.completed, 2);
    assert.equal(after.overall.failedToSend - before.overall.failedToSend, 1);
    assert.equal(after.overall.notYetResponded - before.overall.notYetResponded, 1);
    // responseRatePercent = completed / total; deliveredResponseRatePercent excludes the failed send.
    assert.equal(after.overall.responseRatePercent, Math.round((after.overall.completed / after.overall.total) * 10000) / 100);
    const delivered = after.overall.total - after.overall.failedToSend;
    assert.equal(after.overall.deliveredResponseRatePercent, Math.round((after.overall.completed / delivered) * 10000) / 100);

    const deptBucket = after.byDepartment.find((d) => d.departmentId === dept.id)!;
    assert.equal(deptBucket.nameAr, dept.name_ar);
    assert.equal(deptBucket.total, after.overall.total, 'querying by this one department should match its own overall total');

    const smsBefore = before.byChannel.find((c) => c.channel === 'sms')?.total ?? 0;
    const smsAfter = after.byChannel.find((c) => c.channel === 'sms')!;
    assert.equal(smsAfter.total - smsBefore, 4, 'all 4 non-kiosk inserted rows were sms');
    assert.ok(!after.byChannel.some((c) => c.channel === 'kiosk'), 'kiosk channel must never appear in this report');
    // Every invitation belongs to exactly one channel, so the channel buckets must sum to the total.
    assert.equal(
      after.byChannel.reduce((sum, c) => sum + c.total, 0),
      after.overall.total
    );
  } finally {
    server.close();
  }
});

test('response rate: a DepartmentManager is blocked from another department\'s figures', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const deptCookie = await login(baseUrl, 'department@tajruba.sa', 'Department123!');
    const deptRow = db.prepare("SELECT department_id FROM users WHERE email = 'department@tajruba.sa'").get() as { department_id: string };
    const otherDept = db.prepare('SELECT id FROM departments WHERE id != ? LIMIT 1').get(deptRow.department_id) as { id: string };

    const ownRes = await fetch(`${baseUrl}/api/reports/response-rate?departmentId=${deptRow.department_id}`, { headers: { cookie: deptCookie } });
    assert.equal(ownRes.status, 200);

    const crossRes = await fetch(`${baseUrl}/api/reports/response-rate?departmentId=${otherDept.id}`, { headers: { cookie: deptCookie } });
    assert.equal(crossRes.status, 403);
  } finally {
    server.close();
  }
});
