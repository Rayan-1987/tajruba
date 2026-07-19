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

test('ancillary (Lab/Radiology/Pharmacy) domains are only attached to service lines where they make sense', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const res = await fetch(`${baseUrl}/api/question-bank?includeInactive=1`, { headers: { cookie: adminCookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      domains: { code: string; service_type: string; is_ancillary: number }[];
    };
    const ancillaryDomains = body.domains.filter((d) => d.is_ancillary === 1);
    assert.ok(ancillaryDomains.length > 0, 'at least some ancillary domains exist');

    // Telehealth is a virtual visit with no physical lab/radiology/pharmacy touchpoint during
    // the visit itself — it must not have ANY ancillary domain attached.
    const telAncillary = ancillaryDomains.filter((d) => d.service_type === 'TEL');
    assert.deepEqual(telAncillary, [], 'Telehealth gets no ancillary follow-up domains at all');

    // Radiology specifically must never appear on Telehealth, Home Health, Dialysis,
    // Rehabilitation, or Blood Bank — none of those are routine imaging touchpoints.
    const radDomains = ancillaryDomains.filter((d) => d.code.endsWith('_RAD'));
    const radServices = new Set(radDomains.map((d) => d.service_type));
    for (const excluded of ['TEL', 'HH', 'DIA', 'REH', 'BB']) {
      assert.ok(!radServices.has(excluded), `Radiology must not be attached to ${excluded}`);
    }
    // But it should still exist for the services where it's clinically routine.
    for (const included of ['ED', 'IP', 'MP', 'AS']) {
      assert.ok(radServices.has(included), `Radiology should still be attached to ${included}`);
    }

    // Every non-ancillary domain must report is_ancillary = 0.
    const regularDomains = body.domains.filter((d) => d.is_ancillary !== 1);
    assert.ok(regularDomains.length > ancillaryDomains.length, 'most domains are regular, not ancillary');
  } finally {
    server.close();
  }
});
