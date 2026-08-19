// Automated database backup (RFP INF-05: daily backup, RPO <= 4h, RTO <= 8h).
//
// Runs a consistent point-in-time snapshot via SQLite's own VACUUM INTO, which is safe against a
// WAL-mode database under active write load — no application pause or lock needed. Restoring is
// just copying a backup file back to the configured DATABASE_PATH and restarting the process
// (RTO is however long that takes, well under the 8-hour target for a single SQLite file).
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.ts';

export interface BackupResult {
  ok: boolean;
  fileName?: string;
  sizeBytes?: number;
  error?: string;
}

function timestampForFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function runBackup(db: Db, backupDir: string): BackupResult {
  try {
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const fileName = `tajruba-${timestampForFilename(new Date())}.db`;
    const fullPath = path.join(backupDir, fileName);
    // fullPath is built entirely from a server-generated timestamp, never user input; the quote
    // escaping below is defense in depth, not a response to any untrusted value reaching here.
    db.exec(`VACUUM INTO '${fullPath.replace(/'/g, "''")}'`);
    const sizeBytes = fs.statSync(fullPath).size;
    return { ok: true, fileName, sizeBytes };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Deletes backup files older than retentionDays so disk usage stays bounded. Returns count removed. */
export function pruneOldBackups(backupDir: string, retentionDays: number): number {
  if (!fs.existsSync(backupDir)) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const fileName of fs.readdirSync(backupDir)) {
    if (!fileName.startsWith('tajruba-') || !fileName.endsWith('.db')) continue;
    const fullPath = path.join(backupDir, fileName);
    if (fs.statSync(fullPath).mtimeMs < cutoff) {
      fs.unlinkSync(fullPath);
      removed += 1;
    }
  }
  return removed;
}

export interface BackupListing {
  fileName: string;
  sizeBytes: number;
  createdAt: string;
}

export function listBackups(backupDir: string): BackupListing[] {
  if (!fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith('tajruba-') && f.endsWith('.db'))
    .map((fileName) => {
      const stat = fs.statSync(path.join(backupDir, fileName));
      return { fileName, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Default backup directory used by both the scheduler in server.ts and the admin API in api.ts. */
export function defaultBackupDir(root: string): string {
  return process.env.BACKUP_DIR ?? path.join(root, 'data', 'backups');
}
