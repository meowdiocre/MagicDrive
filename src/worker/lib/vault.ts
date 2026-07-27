import { HTTPException } from 'hono/http-exception'
import { createDriver } from '../drivers/registry'
import { ensurePath, findFolder } from '../drivers/tree'
import { escapeLike } from './path'
import { pickPlacement, release, reserve, reservedBytes } from './placement'
import { driveStatus, invalidateStatus } from './status'
import { encryptSegment, unwrapKey } from './vault-crypto'
import type { Bindings, DriveRecord, VaultObjectRecord, VaultSegmentRecord } from '../types'

export const VAULT_DRIVE_ID = 'vault'
export const VAULT_NAME = 'MagicVault'
/** Provider path for encrypted segment ciphertext. */
export const VAULT_PROVIDER_ROOT = '/MagicVault'

const DEFAULT_SEGMENT_BYTES = 16 * 1024 * 1024
/** Current bound for segment fan-out and range reads. */
export const MAX_OBJECT_BYTES = 4 * 1024 * 1024 * 1024
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000

const OBJECT_COLUMNS = 'id, parent_path, name, path, kind, owner, size, content_type, key_enc, segment_size, status, expires_at, access_mode, access_password_hash'
const SEGMENT_COLUMNS = 'object_id, idx, size, sha256, drive_id, provider_ref'

const README_TEXT = `This folder is managed by MagicDrive (MagicVault).

It holds encrypted pieces of files that belong to this storage's owner.
The pieces are unreadable outside MagicDrive, and deleting them breaks
the files they belong to. Manage them from the MagicDrive app instead.
`

export function segmentSize(env: Bindings): number {
  const override = Number(env.VAULT_SEGMENT_SIZE)
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_SEGMENT_BYTES
}

export function segmentCount(totalBytes: number, perSegment: number): number {
  return Math.ceil(totalBytes / perSegment)
}

export async function getObject(env: Bindings, id: string): Promise<VaultObjectRecord | null> {
  return env.DB.prepare(`SELECT ${OBJECT_COLUMNS} FROM vault_objects WHERE id = ?`)
    .bind(id).first<VaultObjectRecord>()
}

export async function getObjectByPath(env: Bindings, path: string): Promise<VaultObjectRecord | null> {
  return env.DB.prepare(`SELECT ${OBJECT_COLUMNS} FROM vault_objects WHERE path = ?`)
    .bind(path).first<VaultObjectRecord>()
}

/** Hide uploads until commit; folders are always ready. */
export async function listChildren(env: Bindings, parentPath: string): Promise<VaultObjectRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT ${OBJECT_COLUMNS} FROM vault_objects
     WHERE parent_path = ? AND status = 'ready'
     ORDER BY kind DESC, name COLLATE NOCASE ASC`
  ).bind(parentPath).all<VaultObjectRecord>()
  return rows.results ?? []
}

/** Include in-flight uploads so deletion cannot strand them. */
export async function childCount(env: Bindings, parentPath: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM vault_objects WHERE parent_path = ?'
  ).bind(parentPath).first<{ count: number }>()
  return row?.count ?? 0
}

export async function driveHoldsSegments(env: Bindings, driveId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS present FROM vault_segments WHERE drive_id = ?1
     UNION ALL
     SELECT 1 AS present FROM pool_segments WHERE drive_id = ?1
     LIMIT 1`
  ).bind(driveId).first<{ present: number }>()
  return row !== null
}

export async function searchObjects(env: Bindings, query: string): Promise<VaultObjectRecord[]> {
  // ponytail: keep 20 results until folder policies are batch-resolved.
  const rows = await env.DB.prepare(
    `SELECT ${OBJECT_COLUMNS} FROM vault_objects
     WHERE status = 'ready' AND name LIKE ? ESCAPE '\\' COLLATE NOCASE
     ORDER BY name COLLATE NOCASE ASC LIMIT 20`
  ).bind(`%${escapeLike(query)}%`).all<VaultObjectRecord>()
  return rows.results ?? []
}

export async function listSegments(env: Bindings, objectId: string): Promise<VaultSegmentRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT ${SEGMENT_COLUMNS} FROM vault_segments WHERE object_id = ? ORDER BY idx ASC`
  ).bind(objectId).all<VaultSegmentRecord>()
  return rows.results ?? []
}

export async function ownerVaults(env: Bindings, userId: string): Promise<DriveRecord[]> {
  const rows = await env.DB.prepare(
    'SELECT id, user_id, provider, name, root_id, refresh_token_enc, config_enc, granted_scope FROM drives WHERE user_id = ? ORDER BY created_at ASC'
  ).bind(userId).all<DriveRecord>()
  return (rows.results ?? []).filter(drive => {
    try {
      return createDriver(env, drive).capabilities.includes('upload')
    } catch {
      return false
    }
  })
}

export interface CreateObjectInput {
  parentPath: string
  name: string
  path: string
  kind: 'file' | 'folder'
  owner: string
  size?: number
  contentType?: string
  keyEnc?: string
  segmentSize?: number
  uploading?: boolean
}

export async function insertObject(env: Bindings, input: CreateObjectInput): Promise<VaultObjectRecord> {
  const id = crypto.randomUUID()
  const now = new Date()
  const record: VaultObjectRecord = {
    id,
    parent_path: input.parentPath,
    name: input.name,
    path: input.path,
    kind: input.kind,
    owner: input.owner,
    size: input.size ?? null,
    content_type: input.contentType ?? null,
    key_enc: input.keyEnc ?? null,
    segment_size: input.segmentSize ?? null,
    status: input.uploading ? 'uploading' : 'ready',
    expires_at: input.uploading ? new Date(now.getTime() + UPLOAD_TTL_MS).toISOString() : null,
  }
  try {
    await env.DB.prepare(
      `INSERT INTO vault_objects (id, parent_path, name, path, kind, owner, size, content_type, key_enc, segment_size, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      record.id, record.parent_path, record.name, record.path, record.kind, record.owner,
      record.size, record.content_type, record.key_enc, record.segment_size,
      record.status, record.expires_at, now.toISOString(), now.toISOString()
    ).run()
  } catch (cause) {
    if (/unique|constraint/i.test(cause instanceof Error ? cause.message : String(cause))) {
      throw new HTTPException(409, { message: 'That name is already taken here' })
    }
    throw cause
  }
  return record
}

/** Require a real folder owned by the caller; the root remains shared. */
export async function assertParentWritable(env: Bindings, parentPath: string, userId: string): Promise<void> {
  if (parentPath === '/') return
  const parent = await getObjectByPath(env, parentPath)
  if (!parent || parent.kind !== 'folder') {
    throw new HTTPException(404, { message: 'Folder not found' })
  }
  if (parent.owner !== userId) {
    throw new HTTPException(403, { message: 'That folder belongs to someone else' })
  }
}

export async function assertPathFree(env: Bindings, path: string): Promise<void> {
  // Vault paths are case-insensitive.
  const taken = await env.DB.prepare(
    'SELECT 1 AS present FROM vault_objects WHERE path = ? COLLATE NOCASE LIMIT 1'
  ).bind(path).first<{ present: number }>()
  if (taken) throw new HTTPException(409, { message: 'That name is already taken here' })
}

/** Encrypt and place one segment; retrying an index replaces its prior attempt. */
export async function storeSegment(
  env: Bindings,
  object: VaultObjectRecord,
  index: number,
  plaintext: ArrayBuffer
): Promise<VaultSegmentRecord> {
  if (!object.key_enc || !object.owner) throw new HTTPException(500, { message: 'Object has no key' })
  const vaults = await ownerVaults(env, object.owner)
  if (vaults.length === 0) {
    throw new HTTPException(400, { message: 'Connect a writable storage before adding files to MagicVault' })
  }

  const key = await unwrapKey(env.DATA_ENCRYPTION_KEY, object.key_enc)
  const { cipher, sha256 } = await encryptSegment(key, object.id, index, plaintext)

  const scored = await Promise.all(vaults.map(async drive => {
    const status = await driveStatus(env, drive)
    const free = status.usage?.freeBytes
    const held = await env.DB.prepare(
      `SELECT COALESCE(SUM(s.size), 0) AS held
         FROM vault_segments s
         JOIN vault_objects o ON o.id = s.object_id
        WHERE s.drive_id = ? AND o.owner = ?`
    ).bind(drive.id, object.owner).first<{ held: number }>()
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
  if (!target) throw new HTTPException(507, { message: 'No connected vault has room for this piece' })
  await reserve(env, target.id, cipher.byteLength)
  let stored: { id: string } | null = null
  let committed = false
  const driver = createDriver(env, target)
  try {
    const folder = `${VAULT_PROVIDER_ROOT}/objects/${object.id}`
    await ensurePath(driver, folder)
    await placeReadme(env, driver, target.id)
    // Unique attempt IDs prevent a retry from overwriting the predecessor.
    stored = await driver.upload(
      folder, `${index}-${crypto.randomUUID()}.bin`,
      toArrayBuffer(cipher), 'application/octet-stream', cipher.byteLength
    )

    // Replace the row before removing the predecessor, which may use another vault.
    const previous = await env.DB.prepare(
      `SELECT ${SEGMENT_COLUMNS} FROM vault_segments WHERE object_id = ? AND idx = ?`
    ).bind(object.id, index).first<VaultSegmentRecord>()

    // Removing first could leave the row pointing at deleted bytes.
    const record: VaultSegmentRecord = {
      object_id: object.id, idx: index, size: plaintext.byteLength,
      sha256, drive_id: target.id, provider_ref: stored.id,
    }
    await env.DB.prepare(
      `INSERT OR REPLACE INTO vault_segments (object_id, idx, size, sha256, drive_id, provider_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(record.object_id, record.idx, record.size, record.sha256, record.drive_id, record.provider_ref, new Date().toISOString()).run()
    committed = true
    if (previous && previous.provider_ref !== stored.id) await removeSegmentData(env, previous)

    // Release the reservation once the probe can account for these bytes.
    await invalidateStatus(env, target.id)
    return record
  } catch (cause) {
    if (stored && !committed) await driver.remove(stored.id).catch(() => {})
    throw cause
  } finally {
    // Reservations are a safety hint, not durable accounting. Always release
    // them after the attempt; the 10-minute TTL is only a last-resort cleanup.
    await release(env, target.id, cipher.byteLength).catch(() => {})
  }
}

async function placeReadme(env: Bindings, driver: ReturnType<typeof createDriver>, driveId: string): Promise<void> {
  const existing = await env.DB.prepare(
    'SELECT 1 AS present FROM vault_segments WHERE drive_id = ? LIMIT 1'
  ).bind(driveId).first<{ present: number }>()
  if (existing) return
  const bytes = new TextEncoder().encode(README_TEXT)
  await driver.upload(VAULT_PROVIDER_ROOT, 'README.txt', toArrayBuffer(bytes), 'text/plain', bytes.byteLength)
    .catch(() => {})
}

export async function loadDriveById(env: Bindings, driveId: string): Promise<DriveRecord | null> {
  return env.DB.prepare(
    'SELECT id, user_id, provider, name, root_id, refresh_token_enc, config_enc, granted_scope FROM drives WHERE id = ?'
  ).bind(driveId).first<DriveRecord>()
}

async function removeSegmentData(env: Bindings, segment: VaultSegmentRecord): Promise<boolean> {
  const drive = await loadDriveById(env, segment.drive_id)
  if (!drive) return true
  try {
    await createDriver(env, drive).remove(segment.provider_ref)
    return true
  } catch {
    return false
  }
}

/** Remove ciphertext after its D1 rows are gone; provider failures leave unreadable orphan bytes. */
async function deleteSegmentData(env: Bindings, objectId: string, known?: VaultSegmentRecord[]): Promise<void> {
  const segments = known ?? await listSegments(env, objectId)
  const driveIds = [...new Set(segments.map(segment => segment.drive_id))]
  await Promise.all(driveIds.map(async driveId => {
    const drive = await loadDriveById(env, driveId)
    if (!drive) return
    // Prefer removing the whole object folder; fall back to individual segments.
    try {
      const driver = createDriver(env, drive)
      const folder = await findFolder(driver, `${VAULT_PROVIDER_ROOT}/objects`, objectId)
      if (folder) {
        await driver.remove(folder.id)
        return
      }
    } catch {}
    await Promise.all(
      segments.filter(segment => segment.drive_id === driveId)
        .map(segment => removeSegmentData(env, segment))
    )
  }))
}

export async function deleteObjectData(env: Bindings, object: VaultObjectRecord): Promise<void> {
  const segments = await listSegments(env, object.id)
  await env.DB.prepare('DELETE FROM vault_objects WHERE id = ?').bind(object.id).run()
  await deleteSegmentData(env, object.id, segments)
}

/** Claim expired uploads before deleting provider bytes so a racing commit survives. */
export async function cleanupExpiredUploads(env: Bindings): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT ${OBJECT_COLUMNS} FROM vault_objects WHERE status = 'uploading' AND expires_at < ?`
  ).bind(new Date().toISOString()).all<VaultObjectRecord>()

  let swept = 0
  for (const object of rows.results ?? []) {
    const segments = await listSegments(env, object.id)
    const claimed = await env.DB.prepare(
      "DELETE FROM vault_objects WHERE id = ? AND status = 'uploading'"
    ).bind(object.id).run()
    if (!claimed.meta.changes) continue
    await deleteSegmentData(env, object.id, segments)
    swept += 1
  }
  return swept
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
