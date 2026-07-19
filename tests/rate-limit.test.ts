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

test('the login endpoint is rate-limited after repeated attempts from the same client', async () => {
  const { server, baseUrl } = await startServer();
  try {
    let sawTooManyRequests = false;
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'admin@tajruba.sa', password: 'wrong-password' })
      });
      if (res.status === 429) {
        sawTooManyRequests = true;
        const body = (await res.json()) as { error: string };
        assert.equal(body.error, 'too_many_attempts');
        break;
      }
      assert.equal(res.status, 401, 'wrong password is rejected normally until the limit kicks in');
    }
    assert.ok(sawTooManyRequests, 'the 21st attempt within the window should be rate-limited (limit is 20)');
  } finally {
    server.close();
  }
});

test('normal login usage well under the limit is never rate-limited', async () => {
  const { server, baseUrl } = await startServer();
  try {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'admin@tajruba.sa', password: 'Tajruba123!' })
      });
      assert.equal(res.status, 200);
    }
  } finally {
    server.close();
  }
});
