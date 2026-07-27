import type { Context, Next } from 'hono'
import { fail } from '../lib/http'
import { randomToken, sha256Hex } from '../lib/crypto'
import type { AppEnv, Bindings, Session, UserRole } from '../types'

const SESSION_TTL = 60 * 60 * 24 * 14
const SESSION_COOKIE = 'vd_session'
const DRIVE_UNLOCK_TTL = 60 * 30

function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=') || null
  }
  return null
}

function cookieOptions(request: Request, maxAge: number): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

export async function createSession(env: Bindings, session: Session): Promise<string> {
  const token = randomToken(32)
  await env.SESSIONS.put(`session:${await sha256Hex(token)}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL,
  })
  return token
}

export async function readSession(request: Request, env: Bindings): Promise<Session | null> {
  const token = cookieValue(request.headers.get('Cookie'), SESSION_COOKIE)
  if (!token) return null
  const value = await env.SESSIONS.get(`session:${await sha256Hex(token)}`)
  if (!value) return null
  try {
    return JSON.parse(value) as Session
  } catch {
    return null
  }
}

export async function destroySession(request: Request, env: Bindings): Promise<Headers> {
  const token = cookieValue(request.headers.get('Cookie'), SESSION_COOKIE)
  if (token) await env.SESSIONS.delete(`session:${await sha256Hex(token)}`)
  const headers = new Headers()
  headers.append('Set-Cookie', cookieOptions(request, 0))
  return headers
}

export function sessionCookie(request: Request, token: string): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}${secure}`
}

export async function requireSession(c: Context<AppEnv>, next: Next) {
  const session = c.get('session') ?? await readSession(c.req.raw, c.env)
  if (!session) return fail(c, 'Authentication required', 401)
  c.set('session', session)
  await next()
}

// Reads are public, so these routes attach a session when there is one and
// carry on without it otherwise.
export async function optionalSession(c: Context<AppEnv>, next: Next) {
  const session = await readSession(c.req.raw, c.env)
  if (session) c.set('session', session)
  await next()
}

/** Only valid behind requireSession. */
export function getSession(c: Context<AppEnv>): Session {
  return c.get('session')!
}

export function tryGetSession(c: Context<AppEnv>): Session | null {
  return c.get('session') ?? null
}

export interface OAuthState {
  returnTo: string
  userId: string
  accessMode: 'public' | 'protected' | 'private'
  accessPasswordHash: string | null
  poolContributor: boolean
}

export async function saveOAuthState(env: Bindings, state: string, value: OAuthState): Promise<void> {
  await env.SESSIONS.put(`oauth:${state}`, JSON.stringify(value), { expirationTtl: 600 })
}

export async function consumeOAuthState(env: Bindings, state: string): Promise<OAuthState | null> {
  const key = `oauth:${state}`
  const stored = await env.SESSIONS.get(key)
  await env.SESSIONS.delete(key)
  if (!stored) return null
  try {
    const parsed = JSON.parse(stored) as Partial<OAuthState>
    if (typeof parsed.returnTo !== 'string' || typeof parsed.userId !== 'string') return null
    const accessMode = ['public', 'protected', 'private'].includes(parsed.accessMode ?? '')
      ? parsed.accessMode!
      : 'public'
    const accessPasswordHash = typeof parsed.accessPasswordHash === 'string'
      ? parsed.accessPasswordHash
      : null
    if (accessMode === 'protected' && !accessPasswordHash) return null
    return {
      returnTo: parsed.returnTo,
      userId: parsed.userId,
      accessMode,
      accessPasswordHash,
      poolContributor: typeof parsed.poolContributor === 'boolean' ? parsed.poolContributor : true,
    }
  } catch {
    return null
  }
}

export async function grantDriveUnlock(request: Request, env: Bindings, driveId: string): Promise<string> {
  const token = randomToken(32)
  await env.SESSIONS.put(`unlock:${driveId}:${await sha256Hex(token)}`, '1', { expirationTtl: DRIVE_UNLOCK_TTL })
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${await unlockCookieName(driveId)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DRIVE_UNLOCK_TTL}${secure}`
}

export async function hasDriveUnlock(request: Request, env: Bindings, driveId: string): Promise<boolean> {
  const token = cookieValue(request.headers.get('Cookie'), await unlockCookieName(driveId))
  if (!token) return false
  return await env.SESSIONS.get(`unlock:${driveId}:${await sha256Hex(token)}`) === '1'
}

async function unlockCookieName(driveId: string): Promise<string> {
  return `md_unlock_${(await sha256Hex(driveId)).slice(0, 20)}`
}

/**
 * Magicians are named one by one, with no "*" shorthand: the role writes into
 * storage other people contributed, so it is never granted wholesale.
 */
export function magicianUser(username: string, configured: string | undefined): boolean {
  return (configured ?? '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean)
    .includes(username.toLowerCase())
}

/** Read per request rather than trusted from the session, so a revoked role bites at once. */
export async function loadAccount(env: Bindings, userId: string): Promise<{ username: string; role: UserRole } | null> {
  return env.DB.prepare('SELECT username, role FROM users WHERE id = ?')
    .bind(userId).first<{ username: string; role: UserRole }>()
}

/** MAGICIAN_USERS is the live source of truth; the stored role is a display cache. */
export function effectiveRole(env: Bindings, account: { username: string; role: UserRole }): UserRole {
  if (magicianUser(account.username, env.MAGICIAN_USERS)) return 'magician'
  return account.role === 'magician' ? 'owner' : account.role
}

export async function isMagician(c: Context<AppEnv>): Promise<boolean> {
  const session = tryGetSession(c)
  if (!session) return false
  const account = await loadAccount(c.env, session.userId)
  return account !== null && effectiveRole(c.env, account) === 'magician'
}
