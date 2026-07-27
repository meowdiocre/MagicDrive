import { Hono } from 'hono'
import type { Context } from 'hono'
import { createSession, magicianUser, sessionCookie } from '../auth/session'
import { sha256Hex } from '../lib/crypto'
import { fail, ok } from '../lib/http'
import { normalizeSpell, normalizeUsername, spellHash, spellWeakness, USERNAME_PATTERN } from '../lib/spell'
import type { AppEnv, Bindings, Session, UserRecord, UserRole } from '../types'

/** A spell is the whole credential, so guessing at it is throttled per address. */
const MAX_ATTEMPTS = 10
const ATTEMPT_WINDOW_SECONDS = 600

export const authRoutes = new Hono<AppEnv>()

authRoutes.post('/register', async c => {
  const body = await c.req.json<{ username?: string; spell?: string; invite?: string }>().catch(() => null)

  const invite = c.env.INVITE_SPELL ?? ''
  if (invite && normalizeSpell(body?.invite ?? '') !== normalizeSpell(invite)) {
    return fail(c, 'That invite spell is not recognised', 403)
  }

  const username = normalizeUsername(body?.username ?? '')
  if (!USERNAME_PATTERN.test(username)) {
    return fail(c, 'A username is 3–24 characters: letters, digits, hyphen or underscore, starting with a letter or digit', 400)
  }
  const spell = body?.spell ?? ''
  const weakness = spellWeakness(spell)
  if (weakness) return fail(c, weakness, 400)

  const hash = await spellHash(c.env.DATA_ENCRYPTION_KEY, spell)
  // Told apart up front so the message is accurate when both collide; the UNIQUE
  // constraints remain the real guard against a race.
  const clash = await c.env.DB.prepare(
    `SELECT EXISTS (SELECT 1 FROM users WHERE username = ?1) AS name_taken,
            EXISTS (SELECT 1 FROM users WHERE spell_hash = ?2) AS spell_taken`
  ).bind(username, hash).first<{ name_taken: number; spell_taken: number }>()
  if (clash?.name_taken) return fail(c, 'That name is already spoken for', 409)
  if (clash?.spell_taken) return fail(c, 'That spell is already in use. Conjure another.', 409)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const role: UserRole = magicianUser(username, c.env.MAGICIAN_USERS) ? 'magician' : 'owner'
  try {
    await c.env.DB.prepare(
      `INSERT INTO users (id, username, spell_hash, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, username, hash, role, now, now).run()
  } catch {
    return fail(c, 'That name or spell was taken a moment ago. Try again.', 409)
  }

  return signIn(c, { id, username, spell_hash: hash, role }, 201)
})

authRoutes.post('/login', async c => {
  const address = c.req.header('CF-Connecting-IP') ?? 'unknown'
  if (await throttled(c.env, address)) {
    return fail(c, 'Too many attempts. Wait a few minutes before casting again.', 429)
  }

  const body = await c.req.json<{ spell?: string }>().catch(() => null)
  const spell = body?.spell ?? ''
  if (!normalizeSpell(spell)) return fail(c, 'Say the spell', 400)

  const hash = await spellHash(c.env.DATA_ENCRYPTION_KEY, spell)
  const user = await c.env.DB.prepare(
    'SELECT id, username, spell_hash, role FROM users WHERE spell_hash = ?'
  ).bind(hash).first<UserRecord>()
  // One message for both halves: which spells exist is not something to leak.
  if (!user) return fail(c, 'That spell opens nothing', 401)

  await c.env.DB.prepare('DELETE FROM login_attempts WHERE address_hash = ?')
    .bind(await attemptKey(c.env, address)).run()
  return signIn(c, user, 200)
})

/**
 * Roles are recomputed at sign-in from MAGICIAN_USERS, so removing a name there
 * takes the role away without touching the database.
 */
async function signIn(c: Context<AppEnv>, user: UserRecord, status: 200 | 201) {
  const granted: UserRole = magicianUser(user.username, c.env.MAGICIAN_USERS)
    ? 'magician'
    : user.role === 'magician' ? 'owner' : user.role
  if (granted !== user.role) {
    await c.env.DB.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?')
      .bind(granted, new Date().toISOString(), user.id).run()
  }

  // A fresh account has no storage yet; the drive resolver falls back on its own.
  const drive = await c.env.DB.prepare(
    'SELECT id FROM drives WHERE user_id = ? ORDER BY created_at ASC'
  ).bind(user.id).first<{ id: string }>()

  const session: Session = { userId: user.id, driveId: drive?.id ?? '', username: user.username, role: granted }
  c.header('Set-Cookie', sessionCookie(c.req.raw, await createSession(c.env, session)))
  return ok(c, { user: session }, status)
}

async function attemptKey(env: Bindings, address: string): Promise<string> {
  return sha256Hex(`${env.DATA_ENCRYPTION_KEY}:${address}`)
}

async function throttled(env: Bindings, address: string): Promise<boolean> {
  const key = await attemptKey(env, address)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ATTEMPT_WINDOW_SECONDS * 1000).toISOString()
  await env.DB.prepare(
    `INSERT INTO login_attempts (address_hash, attempts, expires_at)
     VALUES (?, 1, ?)
     ON CONFLICT(address_hash) DO UPDATE SET
       attempts = CASE WHEN expires_at <= ? THEN 1 ELSE attempts + 1 END,
       expires_at = CASE WHEN expires_at <= ? THEN ? ELSE expires_at END`
  ).bind(key, expiresAt, now.toISOString(), now.toISOString(), expiresAt).run()
  const row = await env.DB.prepare(
    'SELECT attempts FROM login_attempts WHERE address_hash = ?'
  ).bind(key).first<{ attempts: number }>()
  return (row?.attempts ?? 1) > MAX_ATTEMPTS
}
