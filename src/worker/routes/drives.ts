import { Hono } from 'hono'
import { getSession, grantDriveUnlock, hasDriveUnlock, tryGetSession } from '../auth/session'
import { encryptSecret, sha256Hex } from '../lib/crypto'
import { driveAccessMode, prepareStorageAccess, verifyStorageAccessPassword } from '../lib/access'
import { fail, ok } from '../lib/http'
import { createDriver, providerById, validateConfig } from '../drivers/registry'
import { GLOBAL_DRIVE_ID, POOL_NAME } from '../drivers/aggregate'
import { driveStatus } from '../lib/status'
import { driveHoldsSegments, VAULT_DRIVE_ID, VAULT_NAME } from '../lib/vault'
import { isPoolContributor } from '../lib/pool'
import type { AppEnv, DriveRecord } from '../types'

const DRIVE_COLUMNS = 'id, user_id, provider, provider_variant, name, root_id, refresh_token_enc, config_enc, granted_scope, access_mode, access_password_hash, pool_contributor'
const UNLOCK_ATTEMPT_LIMIT = 10
const UNLOCK_ATTEMPT_TTL = 10 * 60

export const driveRoutes = new Hono<AppEnv>()

driveRoutes.get('/', async c => {
  const session = tryGetSession(c)
  const rows = await c.env.DB.prepare(
    `SELECT d.*, u.username AS owner_name
     FROM drives d JOIN users u ON u.id = d.user_id ORDER BY d.created_at ASC`
  ).all<DriveRecord & { created_at: string; updated_at: string; owner_name: string }>()
  const allRecords = rows.results ?? []
  const poolRecords = allRecords.filter(isPoolContributor)
  const records = allRecords.filter(record =>
    driveAccessMode(record) !== 'private' || session?.userId === record.user_id
  )
  // Names and files are public, but provider quota and failure details belong to
  // the account that connected that storage. Do not even probe other accounts.
  const statuses = await Promise.all(records.map(record =>
    session?.userId === record.user_id ? driveStatus(c.env, record) : null
  ))
  const unlocked = await Promise.all(records.map(record =>
    driveAccessMode(record) === 'protected'
      ? hasDriveUnlock(c.req.raw, c.env, record.id)
      : true
  ))

  const real = records.map((record, index) => {
    const isOwner = Boolean(session && record.user_id === session.userId)
    return {
      id: record.id,
      provider: record.provider,
      provider_variant: record.provider_variant ?? record.provider,
      provider_label: providerById(record.provider_variant ?? record.provider)?.label ?? record.provider,
      name: record.name,
      created_at: record.created_at,
      updated_at: record.updated_at,
      owner_name: record.owner_name,
      is_owner: isOwner,
      is_virtual: false,
      access_mode: driveAccessMode(record),
      locked: driveAccessMode(record) === 'protected' && !unlocked[index],
      pool_contributor: isPoolContributor(record),
      usage: isOwner ? statuses[index]?.usage : undefined,
      health: isOwner ? statuses[index]?.health : undefined,
    }
  })

  // The pooled storage and MagicVault are synthetic: no rows, cannot be removed.
  // Aggregate quota would reveal other contributors' account capacity, so the
  // synthetic drives intentionally expose no usage or provider error details.
  const firstRecord = allRecords[0]
  const items = allRecords.length > 0
    ? [...(poolRecords.length > 0 ? [{
        id: GLOBAL_DRIVE_ID,
        provider: 'global',
        name: POOL_NAME,
        created_at: firstRecord.created_at,
        updated_at: firstRecord.updated_at,
        owner_name: '',
        is_owner: false,
        is_virtual: true,
        access_mode: 'public' as const,
        locked: false,
        pool_contributor: false,
      }] : []), {
        id: VAULT_DRIVE_ID,
        provider: 'vault',
        name: VAULT_NAME,
        created_at: firstRecord.created_at,
        updated_at: firstRecord.updated_at,
        owner_name: '',
        is_owner: false,
        is_virtual: true,
        access_mode: 'private' as const,
        locked: false,
        pool_contributor: false,
      }, ...real]
    : []

  // Physical storage is opened only through an explicit `?drive=<id>` link.
  // The unqualified site always starts in a shared virtual workspace.
  const fallback = poolRecords.length > 0 ? GLOBAL_DRIVE_ID : (allRecords.length > 0 ? VAULT_DRIVE_ID : '')
  return ok(c, { items, activeDriveId: fallback })
})

driveRoutes.post('/:id/unlock', async c => {
  const body = await c.req.json<{ password?: unknown }>().catch(() => null)
  if (typeof body?.password !== 'string') return fail(c, 'Storage password is required', 400)
  const drive = await c.env.DB.prepare(
    `SELECT ${DRIVE_COLUMNS} FROM drives WHERE id = ?`
  ).bind(c.req.param('id')).first<DriveRecord>()
  if (!drive || driveAccessMode(drive) !== 'protected' || !drive.access_password_hash) {
    return fail(c, 'Storage not found', 404)
  }
  const address = c.req.header('CF-Connecting-IP') || 'unknown'
  const attemptKey = `unlock-attempt:${drive.id}:${await sha256Hex(`${c.env.DATA_ENCRYPTION_KEY}:${address}`)}`
  const attempts = Number(await c.env.SESSIONS.get(attemptKey) ?? 0)
  if (attempts >= UNLOCK_ATTEMPT_LIMIT) return fail(c, 'Too many unlock attempts. Try again later.', 429)
  if (!await verifyStorageAccessPassword(c.env.DATA_ENCRYPTION_KEY, body.password, drive.access_password_hash)) {
    await c.env.SESSIONS.put(attemptKey, String(attempts + 1), { expirationTtl: UNLOCK_ATTEMPT_TTL })
    return fail(c, 'Incorrect storage password', 401)
  }
  await c.env.SESSIONS.delete(attemptKey)
  c.header('Set-Cookie', await grantDriveUnlock(c.req.raw, c.env, drive.id))
  return ok(c, { unlocked: true })
})

driveRoutes.patch('/:id', async c => {
  const session = getSession(c)
  const body = await c.req.json<{ name?: string; poolContributor?: unknown }>().catch(() => null)
  const name = (body?.name ?? '').trim().slice(0, 100)
  if (!name) return fail(c, 'name is required', 400)
  if (body?.poolContributor !== undefined && typeof body.poolContributor !== 'boolean') {
    return fail(c, 'poolContributor must be boolean', 400)
  }

  const result = await c.env.DB.prepare(
    'UPDATE drives SET name = ?, pool_contributor = COALESCE(?, pool_contributor), updated_at = ? WHERE id = ? AND user_id = ?'
  ).bind(
    name,
    body?.poolContributor === undefined ? null : body.poolContributor ? 1 : 0,
    new Date().toISOString(), c.req.param('id'), session.userId,
  ).run()
  if (!result.meta.changes) return fail(c, 'Storage not found, or you do not own it', 404)
  return ok(c, { id: c.req.param('id'), name })
})

driveRoutes.post('/', async c => {
  const session = getSession(c)
  const body = await c.req.json<{
    provider?: string
    name?: string
    config?: Record<string, string>
    accessMode?: unknown
    password?: unknown
    poolContributor?: unknown
  }>().catch(() => null)
  const definition = body?.provider ? providerById(body.provider) : undefined
  if (!definition || definition.auth !== 'config' || definition.base === 'google') {
    return fail(c, 'Unknown provider (google connects via OAuth)', 400)
  }
  const name = (body?.name ?? '').trim().slice(0, 100)
  if (!name) return fail(c, 'name is required', 400)
  const access = await prepareStorageAccess(c.env.DATA_ENCRYPTION_KEY, body?.accessMode, body?.password)
  if ('error' in access) return fail(c, access.error, 400)
  if (body?.poolContributor !== undefined && typeof body.poolContributor !== 'boolean') {
    return fail(c, 'poolContributor must be boolean', 400)
  }
  const poolContributor = body?.poolContributor === false ? 0 : 1

  const validated = validateConfig(definition.base, body?.config ?? {})
  if ('error' in validated) return fail(c, validated.error, 400)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const configEnc = await encryptSecret(c.env.DATA_ENCRYPTION_KEY, JSON.stringify(validated.ok))

  // Presets store their base id: the schema and drivers know bases only.
  const record: DriveRecord = {
    id, user_id: session.userId, provider: definition.base,
    provider_variant: definition.id,
    name, root_id: 'root', refresh_token_enc: null, config_enc: configEnc, granted_scope: '',
    access_mode: access.mode, access_password_hash: access.passwordHash,
    pool_contributor: poolContributor,
  }
  try {
    await createDriver(c.env, record).list('/')
  } catch (cause) {
    return fail(c, `Connection test failed: ${cause instanceof Error ? cause.message : 'unknown error'}`, 400)
  }

  await c.env.DB.prepare(
    `INSERT INTO drives (
       id, user_id, provider, provider_variant, name, root_id, refresh_token_enc,
       config_enc, granted_scope, access_mode, access_password_hash, pool_contributor, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, 'root', NULL, ?, '', ?, ?, ?, ?, ?)`
  ).bind(
    id, session.userId, definition.base, definition.id, name, configEnc,
    access.mode, access.passwordHash, poolContributor, now, now,
  ).run()

  return ok(c, {
    id, provider: definition.base, provider_variant: definition.id, name,
    access_mode: access.mode, locked: access.mode === 'protected', pool_contributor: Boolean(poolContributor),
  }, 201)
})

driveRoutes.delete('/:id', async c => {
  const session = getSession(c)
  const id = c.req.param('id')
  // Segments reference the drive by id with no foreign key, so disconnecting a
  // vault that still holds pieces would silently orphan the files they belong to.
  // Checked inside the delete so a segment written meanwhile cannot slip past it.
  const result = await c.env.DB.prepare(
    `DELETE FROM drives
     WHERE id = ?1 AND user_id = ?2
       AND NOT EXISTS (SELECT 1 FROM vault_segments WHERE drive_id = ?1)
       AND NOT EXISTS (SELECT 1 FROM pool_segments WHERE drive_id = ?1)`
  ).bind(id, session.userId).run()
  if (!result.meta.changes) {
    return await driveHoldsSegments(c.env, id)
      ? fail(c, `This storage holds encrypted MagicVault or Cauldron pieces. Delete those files first.`, 409)
      : fail(c, 'Storage not found, or you do not own it', 404)
  }
  return ok(c, { deleted: true })
})

// No user filter: any member may read any storage. Writes check ownership separately.
export async function loadDrive(c: Parameters<typeof getSession>[0], driveId: string): Promise<DriveRecord | null> {
  return c.env.DB.prepare(
    `SELECT ${DRIVE_COLUMNS} FROM drives WHERE id = ?`
  ).bind(driveId).first<DriveRecord>()
}

export async function loadAllDrives(c: Parameters<typeof getSession>[0]): Promise<DriveRecord[]> {
  const rows = await c.env.DB.prepare(
    `SELECT ${DRIVE_COLUMNS} FROM drives ORDER BY created_at ASC`
  ).all<DriveRecord>()
  return rows.results ?? []
}
