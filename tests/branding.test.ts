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

test('tenant branding: defaults, admin-only updates, validation, and it flows through to public survey pages', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');

    const defaults = (await (await fetch(`${baseUrl}/api/settings/branding`, { headers: { cookie: adminCookie } })).json()) as {
      logoDataUri: string | null;
      primaryColor: string;
    };
    assert.equal(defaults.logoDataUri, null);
    assert.equal(defaults.primaryColor, '#059669');

    // Invalid color is rejected.
    const badColor = await fetch(`${baseUrl}/api/settings/branding`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ primaryColor: 'not-a-color' })
    });
    assert.equal(badColor.status, 400);

    // Non-image data URI is rejected.
    const badLogo = await fetch(`${baseUrl}/api/settings/branding`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ logoDataUri: 'data:text/plain;base64,aGVsbG8=' })
    });
    assert.equal(badLogo.status, 400);

    // Valid update.
    const tinyPngDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const goodUpdate = await fetch(`${baseUrl}/api/settings/branding`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ primaryColor: '#1a2b3c', logoDataUri: tinyPngDataUri })
    });
    assert.equal(goodUpdate.status, 200);
    const updated = (await goodUpdate.json()) as { logoDataUri: string | null; primaryColor: string };
    assert.equal(updated.primaryColor, '#1a2b3c');
    assert.equal(updated.logoDataUri, tinyPngDataUri);

    // Non-admin roles cannot read or write branding.
    const deptManagerCookie = await login(baseUrl, 'department@tajruba.sa', 'Department123!');
    const forbiddenGet = await fetch(`${baseUrl}/api/settings/branding`, { headers: { cookie: deptManagerCookie } });
    assert.equal(forbiddenGet.status, 403);

    // The branding now flows through to a public, unauthenticated survey page. Set a known
    // token on an existing invitation directly (only its hash is normally visible to the app,
    // same pattern used by tests/proms.test.ts) so the public endpoint can be exercised.
    const invitation = db.prepare('SELECT id FROM survey_invitations LIMIT 1').get() as { id: string };
    const rawToken = 'branding-test-token';
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE survey_invitations SET token_hash = ?, status = 'sent', expires_at = ? WHERE id = ?").run(tokenHash, futureExpiry, invitation.id);

    const publicRes = await fetch(`${baseUrl}/api/public/surveys/${rawToken}`);
    assert.equal(publicRes.status, 200);
    const publicBody = (await publicRes.json()) as { branding: { logoDataUri: string | null; primaryColor: string } };
    assert.deepEqual(publicBody.branding, updated);
  } finally {
    server.close();
  }
});
