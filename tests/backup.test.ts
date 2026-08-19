import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { openDatabase } from '../server/db.ts';
import { seedDatabase } from '../server/seed.ts';
import { createApi } from '../server/api.ts';
import { listBackups, pruneOldBackups, runBackup } from '../server/backup.ts';

const root = new URL('..', import.meta.url).pathname;

test('runBackup writes a restorable snapshot, listBackups reports it, and pruneOldBackups removes stale files', () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tajruba-backup-'));
  try {
    const db = openDatabase(':memory:');
    seedDatabase(db, root);

    const result = runBackup(db, backupDir);
    assert.equal(result.ok, true);
    assert.ok(result.fileName);
    assert.ok((result.sizeBytes ?? 0) > 0);

    const fullPath = path.join(backupDir, result.fileName!);
    assert.ok(fs.existsSync(fullPath));

    // The snapshot must be a real, openable SQLite database containing the seeded data.
    const restored = openDatabase(fullPath);
    const tenantCount = (restored.prepare('SELECT COUNT(*) as n FROM tenants').get() as { n: number }).n;
    assert.ok(tenantCount > 0, 'restored backup contains the seeded tenant');
    restored.close();

    const listed = listBackups(backupDir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].fileName, result.fileName);

    // Force the file's mtime into the past, then prune with a 1-day retention window.
    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(fullPath, past, past);
    const removed = pruneOldBackups(backupDir, 1);
    assert.equal(removed, 1);
    assert.equal(listBackups(backupDir).length, 0);

    db.close();
  } finally {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
});

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

test('backup admin endpoints: only SystemAdmin can list/run backups', async () => {
  const originalBackupDir = process.env.BACKUP_DIR;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tajruba-backup-api-'));
  process.env.BACKUP_DIR = tempDir;
  const { server, baseUrl } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');

    const runRes = await fetch(`${baseUrl}/api/settings/backups/run`, { method: 'POST', headers: { cookie: adminCookie } });
    assert.equal(runRes.status, 201);

    const listRes = await fetch(`${baseUrl}/api/settings/backups`, { headers: { cookie: adminCookie } });
    assert.equal(listRes.status, 200);
    const body = (await listRes.json()) as { backups: unknown[]; lastBackupAt: string | null; rpoTargetHours: number; rtoTargetHours: number };
    assert.equal(body.backups.length, 1);
    assert.ok(body.lastBackupAt);
    assert.equal(body.rpoTargetHours, 4);
    assert.equal(body.rtoTargetHours, 8);

    const deptManagerCookie = await login(baseUrl, 'department@tajruba.sa', 'Department123!');
    const forbidden = await fetch(`${baseUrl}/api/settings/backups`, { headers: { cookie: deptManagerCookie } });
    assert.equal(forbidden.status, 403);
  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalBackupDir === undefined) delete process.env.BACKUP_DIR;
    else process.env.BACKUP_DIR = originalBackupDir;
  }
});
