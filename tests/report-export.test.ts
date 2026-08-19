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

test('report exports: scores and departments-breakdown are downloadable as CSV and Excel', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');

    const csvRes = await fetch(`${baseUrl}/api/reports/scores/export?format=csv`, { headers: { cookie: adminCookie } });
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers.get('content-type') ?? '', /text\/csv/);
    const csvText = await csvRes.text();
    assert.ok(csvText.includes('المحور'), 'CSV includes the Arabic header row');

    const xlsxRes = await fetch(`${baseUrl}/api/reports/scores/export?format=xlsx`, { headers: { cookie: adminCookie } });
    assert.equal(xlsxRes.status, 200);
    assert.match(xlsxRes.headers.get('content-type') ?? '', /spreadsheetml/);
    const xlsxBuffer = Buffer.from(await xlsxRes.arrayBuffer());
    // .xlsx files are zip archives — the first two bytes are the "PK" zip signature.
    assert.equal(xlsxBuffer.slice(0, 2).toString(), 'PK');

    const deptCsv = await fetch(`${baseUrl}/api/reports/departments-breakdown/export?format=csv&serviceType=IP`, { headers: { cookie: adminCookie } });
    assert.equal(deptCsv.status, 200);
    assert.match(deptCsv.headers.get('content-type') ?? '', /text\/csv/);

    // Missing serviceType is required for the departments-breakdown export, same as the JSON endpoint.
    const missingServiceType = await fetch(`${baseUrl}/api/reports/departments-breakdown/export?format=csv`, { headers: { cookie: adminCookie } });
    assert.equal(missingServiceType.status, 400);
  } finally {
    server.close();
  }
});
