import { Hono } from 'hono'
import { getSession, hasDriveUnlock, isMagician } from '../auth/session'
import { decodeAggregateId, GLOBAL_DRIVE_ID, POOL_NAME } from '../drivers/aggregate'
import { randomToken, sha256Hex } from '../lib/crypto'
import { driveAccessMode } from '../lib/access'
import { assertFolderReadable } from '../lib/folder-access'
import { fail, ok } from '../lib/http'
import { getPoolObject } from '../lib/pool-vault'
import { getObject, VAULT_DRIVE_ID, VAULT_NAME } from '../lib/vault'
import type { AppEnv, DriveRecord } from '../types'

interface ShareRow {
  id: string
  file_id: string
  name: string
  expires_at: string | null
  created_at: string
  mine: number
  drive_name: string | null
  virtual_drive_id: string | null
}

export const shareRoutes = new Hono<AppEnv>()

shareRoutes.get('/', async c => {
  const session = getSession(c)
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.file_id, s.name, s.expires_at, s.created_at, s.virtual_drive_id,
            s.created_by = ?1 AS mine, d.name AS drive_name
     FROM shares s
     LEFT JOIN drives d ON d.id = s.drive_id
     LEFT JOIN vault_objects v ON s.virtual_drive_id = 'vault' AND v.id = s.file_id
     WHERE s.created_by = ?1 OR d.user_id = ?1 OR v.owner = ?1
     ORDER BY s.created_at DESC`
  ).bind(session.userId).all<ShareRow>()
  const items = (rows.results ?? []).map(row => ({
    ...row,
    drive_name: row.virtual_drive_id === VAULT_DRIVE_ID
      ? VAULT_NAME
      : row.virtual_drive_id === GLOBAL_DRIVE_ID ? POOL_NAME : row.drive_name,
  }))
  return ok(c, { items })
})

shareRoutes.post('/', async c => {
  const session = getSession(c)
  const body = await c.req.json<{ fileId?: string; name?: string; expiresInHours?: number; driveId?: string }>().catch(() => null)
  // WebDAV/S3 ids are base64url object paths, so their length varies widely.
  if (!body?.fileId || !/^[A-Za-z0-9_-]{1,1500}$/.test(body.fileId)) return fail(c, 'Invalid file ID', 400)
  const requestedDriveId = body.driveId || session.driveId
  let driveId: string | null = requestedDriveId
  let virtualDriveId: string | null = null
  if (requestedDriveId === VAULT_DRIVE_ID) {
    driveId = null
    virtualDriveId = VAULT_DRIVE_ID
    const file = await getObject(c.env, body.fileId)
    if (!file || file.kind !== 'file' || file.status !== 'ready') return fail(c, 'File not found', 404)
    await assertFolderReadable(c.env, 'vault', file.parent_path, c.req.raw, session.userId)
  } else if (requestedDriveId === GLOBAL_DRIVE_ID) {
    virtualDriveId = GLOBAL_DRIVE_ID
    let target: ReturnType<typeof decodeAggregateId>
    try {
      target = decodeAggregateId(body.fileId)
    } catch {
      return fail(c, 'Invalid file ID', 400)
    }
    if (target.driveId !== 'managed') return fail(c, 'File not found', 404)
    const file = await getPoolObject(c.env, target.id)
    if (!file || file.status !== 'ready') return fail(c, 'File not found', 404)
    await assertFolderReadable(c.env, 'pool', file.parent_path, c.req.raw, session.userId, false, await isMagician(c))
    driveId = null
  }
  if (!driveId && virtualDriveId !== VAULT_DRIVE_ID && virtualDriveId !== GLOBAL_DRIVE_ID) {
    return fail(c, 'Storage not found', 404)
  }
  const drive = driveId
    ? await c.env.DB.prepare(
      `SELECT id, user_id, provider, provider_variant, name, root_id, refresh_token_enc,
              config_enc, granted_scope, access_mode, access_password_hash, pool_contributor
         FROM drives WHERE id = ?`
    ).bind(driveId).first<DriveRecord>()
    : null
  if (driveId && !drive) return fail(c, 'Storage not found', 404)
  if (drive) {
    const mode = driveAccessMode(drive)
    if (mode === 'private' && drive.user_id !== session.userId) return fail(c, 'Storage not found', 404)
    if (mode === 'protected' && !await hasDriveUnlock(c.req.raw, c.env, drive.id)) {
      return fail(c, 'Storage password required', 423)
    }
  }
  const name = (body.name ?? '').trim().slice(0, 255) || 'Shared file'
  const hours = body.expiresInHours
  if (hours !== undefined && (!Number.isFinite(hours) || hours < 1 || hours > 24 * 365)) {
    return fail(c, 'expiresInHours must be between 1 and 8760', 400)
  }

  const token = randomToken(24)
  const id = crypto.randomUUID()
  const now = new Date()
  const expiresAt = hours ? new Date(now.getTime() + hours * 3600_000).toISOString() : null
  await c.env.DB.prepare(
    `INSERT INTO shares (id, drive_id, virtual_drive_id, file_id, name, token_hash, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, driveId, virtualDriveId, body.fileId, name, await sha256Hex(token), expiresAt, session.userId, now.toISOString()).run()

  return ok(c, { id, token, url: `/s/${token}`, name, expiresAt }, 201)
})

shareRoutes.delete('/:id', async c => {
  const session = getSession(c)
  const result = await c.env.DB.prepare(
    `DELETE FROM shares WHERE id = ?2
       AND (created_by = ?1
         OR drive_id IN (SELECT id FROM drives WHERE user_id = ?1)
         OR (virtual_drive_id = ?3 AND file_id IN (SELECT id FROM vault_objects WHERE owner = ?1)))`
  ).bind(session.userId, c.req.param('id'), VAULT_DRIVE_ID).run()
  if (!result.meta.changes) return fail(c, 'Share not found', 404)
  return ok(c, { deleted: true })
})
