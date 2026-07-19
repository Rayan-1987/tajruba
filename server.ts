import express from 'express';
import path from 'node:path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { openDatabase } from './server/db.ts';
import { seedDatabase } from './server/seed.ts';
import { createApi, autoSendDuePromsAssignments } from './server/api.ts';

dotenv.config();

async function start() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.basename(moduleDir) === 'dist' ? path.dirname(moduleDir) : moduleDir;
  const port = Number(process.env.PORT ?? 3000);
  const sessionSecret = process.env.SESSION_SECRET ?? 'development-only-secret-change-before-deployment-123456';
  if (process.env.NODE_ENV === 'production' && sessionSecret.includes('development-only')) {
    throw new Error('SESSION_SECRET must be configured in production.');
  }
  const db = openDatabase(process.env.DATABASE_PATH ?? path.join(root, 'data', 'tajruba.db'));
  seedDatabase(db, root);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';"
    );
    next();
  });
  app.use('/api', createApi(db, sessionSecret, root));

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ root, server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const clientDir = path.join(root, 'dist', 'client');
    app.use(express.static(clientDir, { maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
  }

  const server = app.listen(port, () => console.log(`Tajruba ready at http://localhost:${port}`));

  // Periodically auto-send any due, free-to-administer PROMs assignments that have a contact
  // phone on file, so follow-up questionnaires (e.g. week-6 pain score) go out without a staff
  // member having to click "إرسال" manually every day.
  const baseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
  const PROMS_AUTO_SEND_INTERVAL_MS = 60 * 60 * 1000;
  const runAutoSend = () =>
    autoSendDuePromsAssignments(db, baseUrl)
      .then(({ sent, failed, skipped, reminded, expired }) => {
        if (sent || failed || reminded || expired) {
          console.log(`PROMs auto-send: sent=${sent} failed=${failed} skipped=${skipped} reminded=${reminded} expired=${expired}`);
        }
      })
      .catch((error) => console.error('PROMs auto-send failed', error));
  runAutoSend();
  const autoSendTimer = setInterval(runAutoSend, PROMS_AUTO_SEND_INTERVAL_MS);

  const shutdown = () =>
    server.close(() => {
      clearInterval(autoSendTimer);
      db.close();
      process.exit(0);
    });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
