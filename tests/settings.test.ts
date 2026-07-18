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

test('only a SystemAdmin can read or change integration settings', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const qualityCookie = await login(baseUrl, 'quality@tajruba.sa', 'Quality123!');
    const denied = await fetch(`${baseUrl}/api/settings/integrations`, { headers: { cookie: qualityCookie } });
    assert.equal(denied.status, 403);

    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const allowed = await fetch(`${baseUrl}/api/settings/integrations`, { headers: { cookie: adminCookie } });
    assert.equal(allowed.status, 200);
    const body = (await allowed.json()) as { smsProvider: string; hisWebhookConfigured: boolean };
    assert.equal(body.smsProvider, 'console');
    assert.equal(body.hisWebhookConfigured, false);
  } finally {
    server.close();
    db.close();
  }
});

test('SMS API key is never returned in full, only masked', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    await fetch(`${baseUrl}/api/settings/integrations`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ smsProvider: 'unifonic', smsApiKey: 'super-secret-key-1234', smsSenderName: 'Tajruba' })
    });
    const res = await fetch(`${baseUrl}/api/settings/integrations`, { headers: { cookie: adminCookie } });
    const body = (await res.json()) as { smsApiKeyMasked: string | null };
    assert.ok(body.smsApiKeyMasked);
    assert.ok(!body.smsApiKeyMasked!.includes('super-secret-key-1234'));
    assert.ok(body.smsApiKeyMasked!.endsWith('1234'));
  } finally {
    server.close();
    db.close();
  }
});

test('the console SMS provider always succeeds on test-send without any external call', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const res = await fetch(`${baseUrl}/api/settings/integrations/test-sms`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '0500000000' })
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; provider: string };
    assert.equal(body.ok, true);
    assert.equal(body.provider, 'console');
  } finally {
    server.close();
    db.close();
  }
});

test('HIS webhook rejects missing/invalid/disabled API keys and accepts a valid enabled one', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');

    const missingKey = await fetch(`${baseUrl}/api/webhooks/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateId: 'x', departmentId: 'y', rows: [{ phone: '0500000000' }] })
    });
    assert.equal(missingKey.status, 401);

    const invalidKey = await fetch(`${baseUrl}/api/webhooks/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Api-Key': 'not-a-real-key' },
      body: JSON.stringify({ templateId: 'x', departmentId: 'y', rows: [{ phone: '0500000000' }] })
    });
    assert.equal(invalidKey.status, 401);

    const keyRes = await fetch(`${baseUrl}/api/settings/integrations/webhook-key/regenerate`, {
      method: 'POST',
      headers: { cookie: adminCookie }
    });
    const { key } = (await keyRes.json()) as { key: string };

    const departments = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie: adminCookie } })).json()) as {
      departments: { id: string; service_type: string }[];
    };
    const templates = (await (await fetch(`${baseUrl}/api/templates`, { headers: { cookie: adminCookie } })).json()) as {
      templates: { id: string; service_type: string }[];
    };
    const edDept = departments.departments.find((d) => d.service_type === 'ED')!;
    const edTemplate = templates.templates.find((t) => t.service_type === 'ED')!;

    const validRes = await fetch(`${baseUrl}/api/webhooks/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Api-Key': key },
      body: JSON.stringify({ templateId: edTemplate.id, departmentId: edDept.id, rows: [{ phone: '0500000001' }] })
    });
    assert.equal(validRes.status, 201);
    const body = (await validRes.json()) as { created: number };
    assert.equal(body.created, 1);

    // Disabling the webhook must immediately reject the same, previously-valid key.
    await fetch(`${baseUrl}/api/settings/integrations`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ hisWebhookEnabled: false })
    });
    const afterDisable = await fetch(`${baseUrl}/api/webhooks/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Api-Key': key },
      body: JSON.stringify({ templateId: edTemplate.id, departmentId: edDept.id, rows: [{ phone: '0500000002' }] })
    });
    assert.equal(afterDisable.status, 401);
  } finally {
    server.close();
    db.close();
  }
});

test('a number on the Do-Not-Contact list is never invited', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const departments = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie: adminCookie } })).json()) as {
      departments: { id: string; service_type: string }[];
    };
    const templates = (await (await fetch(`${baseUrl}/api/templates`, { headers: { cookie: adminCookie } })).json()) as {
      templates: { id: string; service_type: string }[];
    };
    const edDept = departments.departments.find((d) => d.service_type === 'ED')!;
    const edTemplate = templates.templates.find((t) => t.service_type === 'ED')!;

    const addRes = await fetch(`${baseUrl}/api/settings/do-not-contact`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '0511111111', reason: 'طلب المريض عدم التواصل' })
    });
    assert.equal(addRes.status, 201);

    const listRes = await fetch(`${baseUrl}/api/settings/do-not-contact`, { headers: { cookie: adminCookie } });
    const list = (await listRes.json()) as { entries: { id: string; reason: string | null }[]; cooldownDays: number };
    assert.equal(list.entries.length, 1);
    assert.equal(list.cooldownDays, 90);

    const bulkRes = await fetch(`${baseUrl}/api/invitations/bulk`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: edTemplate.id,
        departmentId: edDept.id,
        channel: 'sms',
        rows: [{ phone: '0511111111' }, { phone: '0522222222' }]
      })
    });
    const bulkBody = (await bulkRes.json()) as { created: number; skipped: number };
    assert.equal(bulkBody.created, 1, 'only the non-DNC number should be invited');
    assert.equal(bulkBody.skipped, 1);

    await fetch(`${baseUrl}/api/settings/do-not-contact/${list.entries[0].id}`, { method: 'DELETE', headers: { cookie: adminCookie } });
    const listAfterRemove = (await (await fetch(`${baseUrl}/api/settings/do-not-contact`, { headers: { cookie: adminCookie } })).json()) as {
      entries: unknown[];
    };
    assert.equal(listAfterRemove.entries.length, 0);
  } finally {
    server.close();
    db.close();
  }
});

test('the same phone number is not re-invited within the 90-day cooldown window', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const departments = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie: adminCookie } })).json()) as {
      departments: { id: string; service_type: string }[];
    };
    const templates = (await (await fetch(`${baseUrl}/api/templates`, { headers: { cookie: adminCookie } })).json()) as {
      templates: { id: string; service_type: string }[];
    };
    const edDept = departments.departments.find((d) => d.service_type === 'ED')!;
    const edTemplate = templates.templates.find((t) => t.service_type === 'ED')!;

    const firstInvite = await fetch(`${baseUrl}/api/invitations/bulk`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ templateId: edTemplate.id, departmentId: edDept.id, channel: 'sms', rows: [{ phone: '0533333333' }] })
    });
    assert.equal((await firstInvite.json() as { created: number }).created, 1);

    const secondInvite = await fetch(`${baseUrl}/api/invitations/bulk`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ templateId: edTemplate.id, departmentId: edDept.id, channel: 'sms', rows: [{ phone: '0533333333' }] })
    });
    const secondBody = (await secondInvite.json()) as { created: number; skipped: number };
    assert.equal(secondBody.created, 0, 'a second invitation to the same number within 90 days must be skipped');
    assert.equal(secondBody.skipped, 1);
  } finally {
    server.close();
    db.close();
  }
});
