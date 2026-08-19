// Single sign-on (RFP INT-04): a generic OpenID Connect authorization-code + PKCE flow that
// works against Entra ID (Azure AD), Google Workspace, Okta, or any standard OIDC provider —
// no provider-specific code, since OIDC discovery + JWKS verification is itself the standard.
import { randomBytes, createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface OidcProviderConfig {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const discoveryCache = new Map<string, { config: OidcProviderConfig; fetchedAt: number }>();
const DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1000;

/** Fetches and caches the provider's /.well-known/openid-configuration document. */
export async function discoverOidcConfig(issuerUrl: string): Promise<OidcProviderConfig> {
  const cached = discoveryCache.get(issuerUrl);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_CACHE_TTL_MS) return cached.config;

  const wellKnownUrl = `${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(wellKnownUrl);
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status}) at ${wellKnownUrl}`);
  const doc = (await res.json()) as Partial<OidcProviderConfig>;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri || !doc.issuer) {
    throw new Error('OIDC discovery document is missing required fields');
  }
  const config = doc as OidcProviderConfig;
  discoveryCache.set(issuerUrl, { config, fetchedAt: Date.now() });
  return config;
}

/** Random PKCE code_verifier (43-128 chars per RFC 7636) and its S256 code_challenge. */
export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(48).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

export function buildAuthorizationUrl(
  config: OidcProviderConfig,
  params: { clientId: string; redirectUri: string; state: string; codeChallenge: string }
): string {
  const url = new URL(config.authorization_endpoint);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface OidcTokenResponse {
  id_token: string;
  access_token?: string;
}

export async function exchangeCodeForTokens(
  config: OidcProviderConfig,
  params: { clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string }
): Promise<OidcTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    code: params.code,
    code_verifier: params.codeVerifier
  });
  const res = await fetch(config.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!res.ok) throw new Error(`OIDC token exchange failed (${res.status})`);
  const json = (await res.json()) as Partial<OidcTokenResponse>;
  if (!json.id_token) throw new Error('OIDC token response is missing id_token');
  return json as OidcTokenResponse;
}

export interface OidcIdentity {
  subject: string;
  email: string;
  name: string | null;
}

/**
 * Verifies the ID token's signature against the provider's live JWKS (fetched fresh per call —
 * jose's createRemoteJWKSet does its own short-lived key caching internally) and its issuer,
 * audience, and expiry claims. Throws if verification fails; never trust an unverified token.
 */
export async function verifyIdToken(config: OidcProviderConfig, idToken: string, clientId: string): Promise<OidcIdentity> {
  const jwks = createRemoteJWKSet(new URL(config.jwks_uri));
  const { payload } = await jwtVerify(idToken, jwks, { issuer: config.issuer, audience: clientId });
  const email = typeof payload.email === 'string' ? payload.email : null;
  if (!payload.sub || !email) throw new Error('OIDC ID token is missing sub or email claim');
  const name = typeof payload.name === 'string' ? payload.name : null;
  return { subject: payload.sub, email, name };
}
