import { Hono } from 'hono'
import { consumeOAuthState, readSession, saveOAuthState } from '../auth/session'
import { encryptSecret, randomToken } from '../lib/crypto'
import { prepareStorageAccess } from '../lib/access'
import { fail, ok } from '../lib/http'
import type { AppEnv, DriveRecord } from '../types'

interface GoogleTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

interface GoogleProfile {
  sub: string
  email: string
  name?: string
}

// Google is a storage provider here, not an identity provider: signing in is a
// spell, and this flow only attaches a Drive to an account that already exists.
export const oauthRoutes = new Hono<AppEnv>()

oauthRoutes.post('/google/start', async c => {
  if (!configured(c.env)) return fail(c, 'Google OAuth secrets are not configured', 503)
  const session = await readSession(c.req.raw, c.env)
  if (!session) return fail(c, 'Sign in before connecting Google Drive', 401)
  const body = await c.req.json<{
    returnTo?: string
    accessMode?: unknown
    password?: unknown
    poolContributor?: unknown
  }>().catch(() => null)
  const access = await prepareStorageAccess(c.env.DATA_ENCRYPTION_KEY, body?.accessMode, body?.password)
  if ('error' in access) return fail(c, access.error, 400)
  if (body?.poolContributor !== undefined && typeof body.poolContributor !== 'boolean') {
    return fail(c, 'poolContributor must be boolean', 400)
  }
  const state = randomToken(24)
  const returnTo = safeReturnPath(body?.returnTo || '/')
  await saveOAuthState(c.env, state, {
    returnTo,
    userId: session.userId,
    accessMode: access.mode,
    accessPasswordHash: access.passwordHash,
    poolContributor: body?.poolContributor !== false,
  })

  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(c.req.url),
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    // auth/drive, not drive.readonly: the owner must be able to upload, rename,
    // and delete in the storage they contribute. Connections granted before this
    // keep a read-only token, and the driver reports their capabilities honestly.
    scope: [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/drive',
    ].join(' '),
  })
  return ok(c, { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` })
})

oauthRoutes.get('/google/callback', async c => {
  if (!configured(c.env)) return fail(c, 'Google OAuth secrets are not configured', 503)
  const session = await readSession(c.req.raw, c.env)
  if (!session) return fail(c, 'Sign in before connecting Google Drive', 401)

  const state = c.req.query('state')
  const code = c.req.query('code')
  const providerError = c.req.query('error')
  if (!state) return fail(c, 'Missing OAuth state', 400)
  const savedState = await consumeOAuthState(c.env, state)
  if (!savedState) return fail(c, 'OAuth state is invalid or expired', 400)
  if (savedState.userId !== session.userId) return fail(c, 'OAuth state belongs to another session', 403)
  if (providerError) return fail(c, `Google authorization failed: ${providerError}`, 400)
  if (!code) return fail(c, 'Missing Google authorization code', 400)

  const token = await exchangeCode(c.req.url, c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, code)
  if (!token.access_token) return fail(c, token.error_description || token.error || 'Google token exchange failed', 502)
  const profile = await fetchProfile(token.access_token)

  // One Google connection per account: reconnecting refreshes the same drive
  // rather than stacking duplicates of the same files into the pool.
  const existing = await c.env.DB.prepare(
    "SELECT id, refresh_token_enc FROM drives WHERE user_id = ? AND provider = 'google' ORDER BY created_at ASC"
  ).bind(session.userId).first<Pick<DriveRecord, 'id' | 'refresh_token_enc'>>()
  if (!token.refresh_token && !existing?.refresh_token_enc) {
    return fail(c, 'Google did not return a refresh token. Remove MagicDrive access in your Google account and retry.', 400)
  }

  const driveId = existing?.id ?? crypto.randomUUID()
  const refreshToken = token.refresh_token
    ? await encryptSecret(c.env.DATA_ENCRYPTION_KEY, token.refresh_token)
    : existing!.refresh_token_enc
  const now = new Date().toISOString()
  const name = `${profile.name?.trim() || profile.email}'s Google Drive`
  await c.env.DB.prepare(
    `INSERT INTO drives (
       id, user_id, provider, provider_variant, name, root_id, refresh_token_enc,
       granted_scope, access_mode, access_password_hash, pool_contributor, created_at, updated_at
     )
     VALUES (?, ?, 'google', 'google', ?, 'root', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       refresh_token_enc = excluded.refresh_token_enc,
       granted_scope = excluded.granted_scope,
       access_mode = excluded.access_mode,
       access_password_hash = excluded.access_password_hash,
       pool_contributor = excluded.pool_contributor,
       updated_at = excluded.updated_at`
  ).bind(
    driveId, session.userId, name, refreshToken, token.scope ?? '',
    savedState.accessMode, savedState.accessPasswordHash, savedState.poolContributor ? 1 : 0, now, now,
  ).run()

  await c.env.SESSIONS.put(`google:access:${driveId}`, token.access_token, {
    expirationTtl: Math.max(60, (token.expires_in ?? 3600) - 120),
  })
  return c.redirect(savedState.returnTo)
})

function configured(env: AppEnv['Bindings']): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.DATA_ENCRYPTION_KEY)
}

function safeReturnPath(value: string): string {
  return value.startsWith('/') && !value.startsWith('//') ? value : '/'
}

function callbackUrl(requestUrl: string): string {
  return new URL('/api/auth/google/callback', requestUrl).toString()
}

async function exchangeCode(
  requestUrl: string,
  clientId: string,
  clientSecret: string,
  code: string
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: callbackUrl(requestUrl),
    grant_type: 'authorization_code',
  })
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  return response.json() as Promise<GoogleTokenResponse>
}

async function fetchProfile(accessToken: string): Promise<GoogleProfile> {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) throw new Error('Google profile request failed')
  return response.json() as Promise<GoogleProfile>
}
