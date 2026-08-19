import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
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

/** A minimal mock OpenID Connect provider: discovery doc, JWKS, and a token endpoint that always
 * returns the same pre-signed ID token regardless of the authorization code — enough to exercise
 * this app's own OIDC client logic without needing a real identity provider. */
async function startMockIdp(clientId: string, identity: { sub: string; email: string; name: string }) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const kid = 'test-key';

  const app = express();
  let idpBaseUrl = '';

  app.get('/.well-known/openid-configuration', (_req, res) => {
    res.json({
      issuer: idpBaseUrl,
      authorization_endpoint: `${idpBaseUrl}/authorize`,
      token_endpoint: `${idpBaseUrl}/token`,
      jwks_uri: `${idpBaseUrl}/jwks`
    });
  });
  app.get('/jwks', (_req, res) => res.json({ keys: [{ ...jwk, kid, use: 'sig', alg: 'RS256' }] }));
  app.post('/token', express.urlencoded({ extended: false }), async (_req, res) => {
    const idToken = await new SignJWT({ email: identity.email, name: identity.name })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setSubject(identity.sub)
      .setIssuer(idpBaseUrl)
      .setAudience(clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    res.json({ id_token: idToken, access_token: 'fake-access-token' });
  });

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  idpBaseUrl = `http://127.0.0.1:${port}`;
  return { server, issuerUrl: idpBaseUrl };
}

test('SSO: disabled/unconfigured tenant rejects login attempts', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/api/auth/sso/login?tenantSlug=tajruba-demo`, { redirect: 'manual' });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('SSO: full authorization-code + PKCE round trip auto-provisions a new user, and a repeat login reuses it', async () => {
  const { server, baseUrl } = await startServer();
  const clientId = 'test-client-id';
  const idp = await startMockIdp(clientId, { sub: 'idp-subject-1', email: 'newstaff@kau.edu.sa', name: 'موظف جديد' });
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const configureRes = await fetch(`${baseUrl}/api/settings/sso`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        issuerUrl: idp.issuerUrl,
        clientId,
        clientSecret: 'test-client-secret',
        autoProvisionRole: 'DepartmentManager'
      })
    });
    assert.equal(configureRes.status, 200);

    const loginRedirect = await fetch(`${baseUrl}/api/auth/sso/login?tenantSlug=tajruba-demo`, { redirect: 'manual' });
    assert.equal(loginRedirect.status, 302);
    const location = new URL(loginRedirect.headers.get('location')!);
    assert.equal(location.origin, idp.issuerUrl);
    assert.equal(location.pathname, '/authorize');
    const state = location.searchParams.get('state');
    assert.ok(state, 'authorization URL carries a state parameter');
    assert.ok(location.searchParams.get('code_challenge'), 'authorization URL uses PKCE');

    const callbackRes = await fetch(`${baseUrl}/api/auth/sso/callback?code=fake-auth-code&state=${state}`, { redirect: 'manual' });
    assert.equal(callbackRes.status, 302);
    assert.equal(callbackRes.headers.get('location'), '/dashboard');
    const sessionCookie = (callbackRes.headers.get('set-cookie') ?? '').split(';')[0];
    assert.ok(sessionCookie.includes('tajruba_session'));

    // The new SSO session can now access an authenticated endpoint as the auto-provisioned user.
    const meRes = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: sessionCookie } });
    assert.equal(meRes.status, 200);
    const me = (await meRes.json()) as { user: { email: string; role: string; fullName: string } };
    assert.equal(me.user.email, 'newstaff@kau.edu.sa');
    assert.equal(me.user.role, 'DepartmentManager');
    assert.equal(me.user.fullName, 'موظف جديد');

    // A stolen/reused state must not work twice.
    const replay = await fetch(`${baseUrl}/api/auth/sso/callback?code=fake-auth-code&state=${state}`, { redirect: 'manual' });
    assert.equal(replay.status, 400);

    // A second login with the same identity must reuse the existing account, not create another.
    const secondLoginRedirect = await fetch(`${baseUrl}/api/auth/sso/login?tenantSlug=tajruba-demo`, { redirect: 'manual' });
    const secondState = new URL(secondLoginRedirect.headers.get('location')!).searchParams.get('state');
    const secondCallback = await fetch(`${baseUrl}/api/auth/sso/callback?code=fake-auth-code-2&state=${secondState}`, { redirect: 'manual' });
    assert.equal(secondCallback.status, 302);

    const usersRes = await fetch(`${baseUrl}/api/users`, { headers: { cookie: adminCookie } });
    const usersBody = (await usersRes.json()) as { users: { email: string }[] };
    const matches = usersBody.users.filter((u) => u.email === 'newstaff@kau.edu.sa');
    assert.equal(matches.length, 1, 'only one account exists for this SSO identity after two logins');
  } finally {
    server.close();
    idp.server.close();
  }
});
