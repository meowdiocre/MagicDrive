import { Hono } from 'hono'
import type { Context } from 'hono'
import { getSession, isMagician } from '../auth/session'
import { assertFolderReadable } from '../lib/folder-access'
import { fail, ok } from '../lib/http'
import { isValidName, joinVirtualPath, normalizeVirtualPath } from '../lib/path'
import {
  assertPoolParent, assertPoolPathFree, deletePoolObjectData, getPoolObject,
  insertPoolObject, listPoolSegments, poolVaults, storePoolSegment,
} from '../lib/pool-vault'
import { generateWrappedKey } from '../lib/vault-crypto'
import {
  MAX_OBJECT_BYTES, assertParentWritable, assertPathFree, deleteObjectData,
  getObject, getObjectByPath, insertObject, listSegments, ownerVaults,
  segmentCount, segmentSize, storeSegment,
} from '../lib/vault'
import type { AppEnv, PoolObjectRecord, VaultObjectRecord } from '../types'

type UploadSpace = 'vault' | 'pool'
type UploadLookup =
  | { space: 'vault'; object: VaultObjectRecord; error?: undefined }
  | { space: 'pool'; object: PoolObjectRecord; error?: undefined }
  | { object?: undefined; error: Response }

export const vaultRoutes = new Hono<AppEnv>()

vaultRoutes.post('/uploads', async c => {
  const session = getSession(c)
  const body = await c.req.json<{
    drive?: string
    path?: string
    name?: string
    size?: number
    contentType?: string
  }>().catch(() => null)
  const space = body?.drive === 'global' ? 'pool' : 'vault'
  const name = (body?.name ?? '').trim()
  if (!isValidName(name)) return fail(c, 'Invalid filename', 400)
  const size = Number(body?.size)
  if (!Number.isInteger(size) || size <= 0) return fail(c, 'size must be a positive integer', 400)
  if (size > MAX_OBJECT_BYTES) return fail(c, 'File is larger than MagicDrive accepts (4 GB)', 413)

  let parentPath: string
  try {
    parentPath = normalizeVirtualPath(body?.path)
  } catch {
    return fail(c, 'Invalid path', 400)
  }
  const magician = space === 'pool' && await isMagician(c)
  if (space === 'pool' && !magician) return fail(c, 'Only a magician can upload to The Cauldron', 403)
  await assertFolderReadable(c.env, space, parentPath, c.req.raw, session.userId, false, magician)
  const path = joinVirtualPath(parentPath, name)
  const perSegment = segmentSize(c.env)
  const keyEnc = await generateWrappedKey(c.env.DATA_ENCRYPTION_KEY)
  const contentType = (body?.contentType ?? 'application/octet-stream').slice(0, 255)

  if (space === 'pool') {
    await assertPoolParent(c.env, parentPath)
    await assertPoolPathFree(c.env, path)
    if ((await poolVaults(c.env, parentPath)).length === 0) {
      return fail(c, 'No contributed storage is attached to this folder', 400)
    }
    const object = await insertPoolObject(c.env, {
      parentPath, name, path, owner: session.userId, size, contentType,
      keyEnc, segmentSize: perSegment, uploading: true,
    })
    return ok(c, { id: object.id, drive: 'global', segmentSize: perSegment, segmentCount: segmentCount(size, perSegment) }, 201)
  }

  await assertParentWritable(c.env, parentPath, session.userId)
  await assertPathFree(c.env, path)
  if ((await ownerVaults(c.env, session.userId)).length === 0) {
    return fail(c, 'Connect a writable storage before adding files to MagicVault', 400)
  }
  const object = await insertObject(c.env, {
    parentPath, name, path, kind: 'file', owner: session.userId, size, contentType,
    keyEnc, segmentSize: perSegment, uploading: true,
  })
  return ok(c, { id: object.id, drive: 'vault', segmentSize: perSegment, segmentCount: segmentCount(size, perSegment) }, 201)
})

vaultRoutes.put('/uploads/:id/segments/:idx', async c => {
  const found = await uploadSession(c)
  if (!found.object) return found.error
  const { object, space } = found
  const index = Number(c.req.param('idx'))
  const perSegment = object.segment_size ?? segmentSize(c.env)
  const count = segmentCount(object.size ?? 0, perSegment)
  if (!Number.isInteger(index) || index < 0 || index >= count) return fail(c, 'Segment index out of range', 400)

  const expected = index < count - 1 ? perSegment : (object.size ?? 0) - index * perSegment
  const received = await readExactBody(c.req.raw, expected)
  if (!received.bytes) {
    const got = received.overflow ? `more than ${expected}` : String(received.length)
    return fail(c, `Segment ${index} must be ${expected} bytes, got ${got}`, 400)
  }
  const stored = space === 'pool'
    ? await storePoolSegment(c.env, object as PoolObjectRecord, index, received.bytes)
    : await storeSegment(c.env, object as VaultObjectRecord, index, received.bytes)
  return ok(c, { idx: stored.idx, sha256: stored.sha256 })
})

vaultRoutes.post('/uploads/:id/commit', async c => {
  const found = await uploadSession(c)
  if (!found.object) return found.error
  const { object, space } = found
  const perSegment = object.segment_size ?? segmentSize(c.env)
  const count = segmentCount(object.size ?? 0, perSegment)
  const segments = space === 'pool'
    ? await listPoolSegments(c.env, object.id)
    : await listSegments(c.env, object.id)
  const present = new Set(segments.map(segment => segment.idx))
  const missing: number[] = []
  for (let index = 0; index < count; index += 1) if (!present.has(index)) missing.push(index)
  const storedBytes = segments.reduce((sum, segment) => sum + segment.size, 0)
  if (missing.length > 0 || storedBytes !== object.size) {
    return fail(c, `Upload incomplete: missing segment(s) ${missing.slice(0, 5).join(', ') || 'with wrong sizes'}`, 409)
  }

  const parentExists = object.parent_path === '/' || (space === 'pool'
    ? await c.env.DB.prepare('SELECT 1 AS present FROM pool_folders WHERE path = ?').bind(object.parent_path).first()
    : await getObjectByPath(c.env, object.parent_path))
  if (!parentExists) return fail(c, 'The folder this upload was going into no longer exists', 409)

  const table = space === 'pool' ? 'pool_objects' : 'vault_objects'
  const committed = await c.env.DB.prepare(
    `UPDATE ${table} SET status = 'ready', expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'uploading'`
  ).bind(new Date().toISOString(), object.id).run()
  if (!committed.meta.changes) return fail(c, 'Upload session not found', 404)
  return ok(c, { id: object.id, name: object.name, size: object.size })
})

vaultRoutes.delete('/uploads/:id', async c => {
  const found = await uploadSession(c, true)
  if (!found.object) return found.error
  if (found.space === 'pool') await deletePoolObjectData(c.env, found.object)
  else await deleteObjectData(c.env, found.object)
  return ok(c, { cancelled: true })
})

async function uploadSession(c: Context<AppEnv>, allowExpired = false): Promise<UploadLookup> {
  const session = getSession(c)
  const space: UploadSpace = c.req.query('drive') === 'global' ? 'pool' : 'vault'
  const object = space === 'pool'
    ? await getPoolObject(c.env, c.req.param('id') ?? '')
    : await getObject(c.env, c.req.param('id') ?? '')
  if (!object || object.status !== 'uploading') return { error: fail(c, 'Upload session not found', 404) }
  if (object.owner !== session.userId) return { error: fail(c, 'Not your upload', 403) }
  const magician = space === 'pool' && await isMagician(c)
  if (space === 'pool' && !magician) return { error: fail(c, 'Only a magician can upload to The Cauldron', 403) }
  await assertFolderReadable(c.env, space, object.parent_path, c.req.raw, session.userId, false, magician)
  if (!allowExpired && object.expires_at && object.expires_at < new Date().toISOString()) {
    return { error: fail(c, 'This upload expired; start it again', 410) }
  }
  return space === 'pool'
    ? { space, object: object as PoolObjectRecord }
    : { space, object: object as VaultObjectRecord }
}

async function readExactBody(
  request: Request,
  expected: number,
): Promise<{ bytes: ArrayBuffer | null; length: number; overflow: boolean }> {
  const declared = request.headers.get('Content-Length')
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isInteger(length) || length !== expected) {
      return { bytes: null, length: Number.isFinite(length) ? length : 0, overflow: length > expected }
    }
  }
  const reader = request.body?.getReader()
  if (!reader) return { bytes: null, length: 0, overflow: false }
  const output = new Uint8Array(expected)
  let length = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    if (length + chunk.value.byteLength > expected) {
      await reader.cancel().catch(() => {})
      return { bytes: null, length: length + chunk.value.byteLength, overflow: true }
    }
    output.set(chunk.value, length)
    length += chunk.value.byteLength
  }
  return length === expected
    ? { bytes: output.buffer, length, overflow: false }
    : { bytes: null, length, overflow: false }
}
