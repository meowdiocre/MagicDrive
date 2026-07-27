import { Hono } from 'hono'
import type { Context } from 'hono'
import { grantFolderUnlock, isMagician, tryGetSession } from '../auth/session'
import { decodeAggregateId } from '../drivers/aggregate'
import { sha256Hex } from '../lib/crypto'
import { fail, ok } from '../lib/http'
import {
  getFolderPolicy, getFolderPolicyByPath, prepareFolderAccess, verifyFolderPassword,
} from '../lib/folder-access'
import type { AppEnv } from '../types'

const UNLOCK_ATTEMPT_LIMIT = 10
const UNLOCK_ATTEMPT_TTL = 10 * 60

export const folderRoutes = new Hono<AppEnv>()

folderRoutes.patch('/:space/:id', async c => {
  const session = tryGetSession(c)
  if (!session) return fail(c, 'Authentication required', 401)
  const space = c.req.param('space')
  if (space !== 'vault' && space !== 'pool') return fail(c, 'Invalid folder space', 400)
  const policy = await resolvePolicy(c, space, c.req.param('id'))
  if (!policy) return fail(c, 'Folder not found', 404)
  if (space === 'vault' ? policy.owner !== session.userId : !await isMagician(c)) {
    return fail(c, 'You cannot change this folder access policy', 403)
  }

  const body = await c.req.json<{ accessMode?: unknown; password?: unknown }>().catch(() => null)
  const prepared = await prepareFolderAccess(c.env.DATA_ENCRYPTION_KEY, body?.accessMode, body?.password)
  if ('error' in prepared) return fail(c, prepared.error, 400)
  const table = space === 'vault' ? 'vault_objects' : 'pool_folders'
  await c.env.DB.prepare(
    `UPDATE ${table} SET access_mode = ?, access_password_hash = ? WHERE id = ?`
  ).bind(prepared.mode, prepared.passwordHash, policy.id).run()
  return ok(c, { id: policy.id, accessMode: prepared.mode, locked: prepared.mode === 'protected' })
})

folderRoutes.post('/:space/:id/unlock', async c => {
  const space = c.req.param('space')
  if (space !== 'vault' && space !== 'pool') return fail(c, 'Invalid folder space', 400)
  const policy = await resolvePolicy(c, space, c.req.param('id'))
  if (!policy || policy.access_mode !== 'protected' || !policy.access_password_hash) {
    return fail(c, 'Folder not found', 404)
  }
  const body = await c.req.json<{ password?: unknown }>().catch(() => null)
  if (typeof body?.password !== 'string') return fail(c, 'Folder password is required', 400)
  const address = c.req.header('CF-Connecting-IP') || 'unknown'
  const attemptKey = `folder-unlock-attempt:${space}:${policy.id}:${await sha256Hex(`${c.env.DATA_ENCRYPTION_KEY}:${address}`)}`
  const attempts = Number(await c.env.SESSIONS.get(attemptKey) ?? 0)
  if (attempts >= UNLOCK_ATTEMPT_LIMIT) return fail(c, 'Too many unlock attempts. Try again later.', 429)
  if (!await verifyFolderPassword(c.env.DATA_ENCRYPTION_KEY, body.password, policy.access_password_hash)) {
    await c.env.SESSIONS.put(attemptKey, String(attempts + 1), { expirationTtl: UNLOCK_ATTEMPT_TTL })
    return fail(c, 'Incorrect folder password', 401)
  }
  await c.env.SESSIONS.delete(attemptKey)
  c.header('Set-Cookie', await grantFolderUnlock(c.req.raw, c.env, space, policy.id, policy.access_password_hash))
  return ok(c, { unlocked: true })
})

async function resolvePolicy(c: Context<AppEnv>, space: 'vault' | 'pool', id: string) {
  if (space === 'vault') return getFolderPolicy(c.env, 'vault', id)
  let decoded: { driveId: string; id: string }
  try {
    decoded = decodeAggregateId(id)
  } catch {
    return null
  }
  if (decoded.driveId !== 'pool') return null
  return getFolderPolicyByPath(c.env, 'pool', decoded.id)
}
