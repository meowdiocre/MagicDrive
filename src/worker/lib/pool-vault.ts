import { HTTPException } from 'hono/http-exception'
import { createDriver } from '../drivers/registry'
import { writableDrives } from './capacity'
import { ensurePath, findFolder } from '../drivers/tree'
import { escapeLike } from './path'
import { loadPoolDriveIds } from './pool'
import { pickPlacement, release, reserve, reservedBytes } from './placement'
import { driveStatus, invalidateStatus } from './status'
import { encryptSegment, unwrapKey } from './vault-crypto'
import { loadDriveById } from './vault'
import type { Bindings, DriveRecord, PoolObjectRecord, PoolSegmentRecord } from '../types'

export const POOL_PROVIDER_ROOT = '/MagicCauldron'
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000
const OBJECT_COLUMNS = 'id, parent_path, name, path, owner, size, content_type, key_enc, segment_size, status, expires_at'
const SEGMENT_COLUMNS = 'object_id, idx, size, sha256, drive_id, provider_ref'

const README_TEXT = `This folder is managed by MagicDrive (The Cauldron).

It contains encrypted pieces distributed across contributed storage.
The pieces are unreadable outside MagicDrive. Deleting or changing them
breaks files in The Cauldron. Manage them from the MagicDrive app.
`

export async function getPoolObject(env: Bindings, id: string): Promise<PoolObjectRecord | null> {
  return env.DB.prepare(`SELECT ${OBJECT_COLUMNS} FROM pool_objects WHERE id = ?`)
    .bind(id).first<PoolObjectRecord>()
}

export async function getPoolObjectByPath(env: Bindings, path: string): Promise<PoolObjectRecord | null> {
  return env.DB.prepare(`SELECT ${OBJECT_COLUMNS} FROM pool_objects WHERE path = ?`)
    .bind(path).first<PoolObjectRecord>()
}

export async function listPoolObjects(env: Bindings, parentPath: string): Promise<PoolObjectRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT ${OBJECT_COLUMNS} FROM pool_objects
     WHERE parent_path = ? AND status = 'ready'
     ORDER BY name COLLATE NOCASE ASC`
  ).bind(parentPath).all<PoolObjectRecord>()
  return rows.results ?? []
}

export async function searchPoolObjects(env: Bindings, query: string): Promise<PoolObjectRecord[]> {
  // ponytail: keep 20 results until folder policies are batch-resolved.
  const rows = await env.DB.prepare(
    `SELECT ${OBJECT_COLUMNS} FROM pool_objects
     WHERE status = 'ready' AND name LIKE ? ESCAPE '\\' COLLATE NOCASE
     ORDER BY name COLLATE NOCASE ASC LIMIT 20`
  ).bind(`%${escapeLike(query)}%`).all<PoolObjectRecord>()
  return rows.results ?? []
}

export async function listPoolSegments(env: Bindings, objectId: string): Promise<PoolSegmentRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT ${SEGMENT_COLUMNS} FROM pool_segments WHERE object_id = ? ORDER BY idx ASC`
  ).bind(objectId).all<PoolSegmentRecord>()
  return rows.results ?? []
}

export async function poolVaults(env: Bindings, path: string): Promise<DriveRecord[]> {
  const members = new Set(await loadPoolDriveIds(env.DB, path))
  if (members.size === 0) return []
  const rows = await env.DB.prepare(
    `SELECT id, user_id, provider, provider_variant, name, root_id, refresh_token_enc,
            config_enc, granted_scope, access_mode, access_password_hash, pool_contributor
       FROM drives WHERE pool_contributor != 0 ORDER BY created_at ASC`
  ).all<DriveRecord>()
  return writableDrives(env, (rows.results ?? []).filter(drive => members.has(drive.id))).drives
}

export async function assertPoolParent(env: Bindings, parentPath: string): Promise<void> {
  if (parentPath === '/') {
    throw new HTTPException(403, { message: 'Files can only be added inside a folder in The Cauldron.' })
  }
  const folder = await env.DB.prepare('SELECT 1 AS present FROM pool_folders WHERE path = ?')
    .bind(parentPath).first<{ present: number }>()
  if (!folder) throw new HTTPException(404, { message: 'Pool folder not found' })
  if ((await poolVaults(env, parentPath)).length === 0) {
    throw new HTTPException(400, { message: 'No contributed storage is attached to this folder' })
  }
}

export async function assertPoolPathFree(env: Bindings, path: string): Promise<void> {
  const [file, folder] = await Promise.all([
    env.DB.prepare('SELECT 1 AS present FROM pool_objects WHERE path = ? COLLATE NOCASE LIMIT 1')
      .bind(path).first<{ present: number }>(),
    env.DB.prepare('SELECT 1 AS present FROM pool_folders WHERE path = ? COLLATE NOCASE LIMIT 1')
      .bind(path).first<{ present: number }>(),
  ])
  if (file || folder) throw new HTTPException(409, { message: 'That name is already taken here' })
}

interface CreatePoolObjectInput {
  parentPath: string
  name: string
  path: string
  owner: string
  size: number
  contentType: string
  keyEnc: string
  segmentSize: number
  uploading?: boolean
}

export async function insertPoolObject(env: Bindings, input: CreatePoolObjectInput): Promise<PoolObjectRecord> {
  const now = new Date()
  const record: PoolObjectRecord = {
    id: crypto.randomUUID(),
    parent_path: input.parentPath,
    name: input.name,
    path: input.path,
    owner: input.owner,
    size: input.size,
    content_type: input.contentType,
    key_enc: input.keyEnc,
    segment_size: input.segmentSize,
    status: input.uploading ? 'uploading' : 'ready',
    expires_at: input.uploading ? new Date(now.getTime() + UPLOAD_TTL_MS).toISOString() : null,
  }
  try {
    await env.DB.prepare(
      `INSERT INTO pool_objects
       (id, parent_path, name, path, owner, size, content_type, key_enc, segment_size, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      record.id, record.parent_path, record.name, record.path, record.owner,
      record.size, record.content_type, record.key_enc, record.segment_size,
      record.status, record.expires_at, now.toISOString(), now.toISOString(),
    ).run()
  } catch (cause) {
    if (/unique|constraint/i.test(cause instanceof Error ? cause.message : String(cause))) {
      throw new HTTPException(409, { message: 'That name is already taken here' })
    }
    throw cause
  }
  return record
}

/** Encrypt and place one Cauldron segment; retrying an index replaces its prior attempt. */
export async function storePoolSegment(
  env: Bindings,
  object: PoolObjectRecord,
  index: number,
  plaintext: ArrayBuffer,
): Promise<PoolSegmentRecord> {
  const vaults = await poolVaults(env, object.parent_path)
  if (vaults.length === 0) throw new HTTPException(400, { message: 'No contributed storage is attached to this folder' })

  const key = await unwrapKey(env.DATA_ENCRYPTION_KEY, object.key_enc)
  const { cipher, sha256 } = await encryptSegment(key, object.id, index, plaintext)
  const scored = await Promise.all(vaults.map(async drive => {
    const status = await driveStatus(env, drive)
    const free = status.usage?.freeBytes
    const held = await env.DB.prepare(
      'SELECT COALESCE(SUM(size), 0) AS held FROM pool_segments WHERE drive_id = ?'
    ).bind(drive.id).first<{ held: number }>()
    return {
      entry: drive,
      healthy: status.health.ok,
      held: Number(held?.held) || 0,
      freeBytes: free === null || free === undefined
        ? null
        : Math.max(0, free - await reservedBytes(env, drive.id)),
    }
  }))
  const target = pickPlacement(scored, cipher.byteLength)
  if (!target) throw new HTTPException(507, { message: 'No contributed storage has room for this piece' })

  await reserve(env, target.id, cipher.byteLength)
  let stored: { id: string } | null = null
  let committed = false
  const driver = createDriver(env, target)
  try {
    const folder = `${POOL_PROVIDER_ROOT}/objects/${object.id}`
    await ensurePath(driver, folder)
    await placeReadme(env, driver, target.id)
    stored = await driver.upload(
      folder,
      `${index}-${crypto.randomUUID()}.bin`,
      toArrayBuffer(cipher),
      'application/octet-stream',
      cipher.byteLength,
    )
    const previous = await env.DB.prepare(
      `SELECT ${SEGMENT_COLUMNS} FROM pool_segments WHERE object_id = ? AND idx = ?`
    ).bind(object.id, index).first<PoolSegmentRecord>()
    const record: PoolSegmentRecord = {
      object_id: object.id,
      idx: index,
      size: plaintext.byteLength,
      sha256,
      drive_id: target.id,
      provider_ref: stored.id,
    }
    await env.DB.prepare(
      `INSERT OR REPLACE INTO pool_segments
       (object_id, idx, size, sha256, drive_id, provider_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      record.object_id, record.idx, record.size, record.sha256,
      record.drive_id, record.provider_ref, new Date().toISOString(),
    ).run()
    committed = true
    if (previous && previous.provider_ref !== stored.id) await removePoolSegmentData(env, previous)
    await invalidateStatus(env, target.id)
    return record
  } catch (cause) {
    if (stored && !committed) await driver.remove(stored.id).catch(() => {})
    throw cause
  } finally {
    await release(env, target.id, cipher.byteLength).catch(() => {})
  }
}

async function placeReadme(env: Bindings, driver: ReturnType<typeof createDriver>, driveId: string): Promise<void> {
  const existing = await env.DB.prepare('SELECT 1 AS present FROM pool_segments WHERE drive_id = ? LIMIT 1')
    .bind(driveId).first<{ present: number }>()
  if (existing) return
  const bytes = encoder.encode(README_TEXT)
  await driver.upload(POOL_PROVIDER_ROOT, 'README.txt', toArrayBuffer(bytes), 'text/plain', bytes.byteLength).catch(() => {})
}

export async function fetchPoolSegment(env: Bindings, segment: PoolSegmentRecord): Promise<ArrayBuffer> {
  const drive = await loadDriveById(env, segment.drive_id)
  if (!drive) throw new Error('The contributed storage holding this piece is disconnected')
  const response = await createDriver(env, drive).download(segment.provider_ref, new Request('https://cauldron.internal/'))
  if (!response.ok) throw new Error(`Cauldron read returned ${response.status}`)
  return response.arrayBuffer()
}

async function removePoolSegmentData(env: Bindings, segment: PoolSegmentRecord): Promise<boolean> {
  const drive = await loadDriveById(env, segment.drive_id)
  if (!drive) return true
  try {
    await createDriver(env, drive).remove(segment.provider_ref)
    return true
  } catch {
    return false
  }
}

async function deletePoolSegmentData(env: Bindings, objectId: string, known?: PoolSegmentRecord[]): Promise<void> {
  const segments = known ?? await listPoolSegments(env, objectId)
  const driveIds = [...new Set(segments.map(segment => segment.drive_id))]
  await Promise.all(driveIds.map(async driveId => {
    const drive = await loadDriveById(env, driveId)
    if (!drive) return
    try {
      const driver = createDriver(env, drive)
      const folder = await findFolder(driver, `${POOL_PROVIDER_ROOT}/objects`, objectId)
      if (folder) {
        await driver.remove(folder.id)
        return
      }
    } catch {}
    await Promise.all(segments.filter(segment => segment.drive_id === driveId).map(segment => removePoolSegmentData(env, segment)))
  }))
}

export async function deletePoolObjectData(env: Bindings, object: PoolObjectRecord): Promise<void> {
  const segments = await listPoolSegments(env, object.id)
  await env.DB.prepare('DELETE FROM pool_objects WHERE id = ?').bind(object.id).run()
  await deletePoolSegmentData(env, object.id, segments)
}

export async function deletePoolSubtreeData(env: Bindings, path: string): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT ${OBJECT_COLUMNS} FROM pool_objects WHERE path = ? OR path LIKE ? ESCAPE '\\'`
  ).bind(path, `${escapeLike(path)}/%`).all<PoolObjectRecord>()
  for (const object of rows.results ?? []) await deletePoolObjectData(env, object)
}

export async function cleanupExpiredPoolUploads(env: Bindings): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT ${OBJECT_COLUMNS} FROM pool_objects WHERE status = 'uploading' AND expires_at < ?`
  ).bind(new Date().toISOString()).all<PoolObjectRecord>()
  let swept = 0
  for (const object of rows.results ?? []) {
    const segments = await listPoolSegments(env, object.id)
    const claimed = await env.DB.prepare(
      "DELETE FROM pool_objects WHERE id = ? AND status = 'uploading'"
    ).bind(object.id).run()
    if (!claimed.meta.changes) continue
    await deletePoolSegmentData(env, object.id, segments)
    swept += 1
  }
  return swept
}

const encoder = new TextEncoder()

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
