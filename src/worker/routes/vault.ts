import { Hono } from 'hono'
import type { Context } from 'hono'
import { getSession } from '../auth/session'
import { fail, ok } from '../lib/http'
import { isValidName, joinVirtualPath, normalizeVirtualPath } from '../lib/path'
import { generateWrappedKey } from '../lib/vault-crypto'
import {
  MAX_OBJECT_BYTES, assertParentWritable, assertPathFree, deleteObjectData,
  getObject, getObjectByPath, insertObject, listSegments, ownerVaults, segmentCount, segmentSize, storeSegment,
} from '../lib/vault'
import type { AppEnv, VaultObjectRecord } from '../types'

export const vaultRoutes = new Hono<AppEnv>()

/** MagicVault upload sessions accept one client segment per request. */
vaultRoutes.post('/uploads', async c => {
  const session = getSession(c)
  const body = await c.req.json<{ path?: string; name?: string; size?: number; contentType?: string }>().catch(() => null)
  const name = (body?.name ?? '').trim()
  if (!isValidName(name)) return fail(c, 'Invalid filename', 400)
  const size = Number(body?.size)
  if (!Number.isInteger(size) || size <= 0) return fail(c, 'size must be a positive integer', 400)
  if (size > MAX_OBJECT_BYTES) return fail(c, 'File is larger than MagicVault accepts (4 GB)', 413)

  let parentPath: string
  try {
    parentPath = normalizeVirtualPath(body?.path)
  } catch {
    return fail(c, 'Invalid path', 400)
  }
  await assertParentWritable(c.env, parentPath, session.userId)
  const path = joinVirtualPath(parentPath, name)
  await assertPathFree(c.env, path)

  if ((await ownerVaults(c.env, session.userId)).length === 0) {
    return fail(c, 'Connect a writable storage before adding files to MagicVault', 400)
  }

  const perSegment = segmentSize(c.env)
  const object = await insertObject(c.env, {
    parentPath, name, path, kind: 'file', owner: session.userId,
    size, contentType: (body?.contentType ?? 'application/octet-stream').slice(0, 255),
    keyEnc: await generateWrappedKey(c.env.DATA_ENCRYPTION_KEY),
    segmentSize: perSegment, uploading: true,
  })
  return ok(c, { id: object.id, segmentSize: perSegment, segmentCount: segmentCount(size, perSegment) }, 201)
})

vaultRoutes.put('/uploads/:id/segments/:idx', async c => {
  const { object, error } = await uploadSession(c)
  if (!object) return error!

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

  const stored = await storeSegment(c.env, object, index, received.bytes)
  return ok(c, { idx: stored.idx, sha256: stored.sha256 })
})

vaultRoutes.post('/uploads/:id/commit', async c => {
  const { object, error } = await uploadSession(c)
  if (!object) return error!

  const perSegment = object.segment_size ?? segmentSize(c.env)
  const count = segmentCount(object.size ?? 0, perSegment)
  const segments = await listSegments(c.env, object.id)
  const present = new Set(segments.map(segment => segment.idx))
  const missing: number[] = []
  for (let index = 0; index < count; index += 1) {
    if (!present.has(index)) missing.push(index)
  }
  const storedBytes = segments.reduce((sum, segment) => sum + segment.size, 0)
  if (missing.length > 0 || storedBytes !== object.size) {
    return fail(c, `Upload incomplete: missing segment(s) ${missing.slice(0, 5).join(', ') || 'with wrong sizes'}`, 409)
  }
  // Do not commit into a folder deleted during the upload; leave the session for
  // cancellation or expiry cleanup.
  if (object.parent_path !== '/' && !await getObjectByPath(c.env, object.parent_path)) {
    return fail(c, 'The folder this upload was going into no longer exists', 409)
  }

  // The sweep may have claimed the row meanwhile.
  const committed = await c.env.DB.prepare(
    "UPDATE vault_objects SET status = 'ready', expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'uploading'"
  ).bind(new Date().toISOString(), object.id).run()
  if (!committed.meta.changes) return fail(c, 'Upload session not found', 404)
  return ok(c, { id: object.id, name: object.name, size: object.size })
})

// Allow cancellation after expiry; the row still holds its name until cleanup.
vaultRoutes.delete('/uploads/:id', async c => {
  const { object, error } = await uploadSession(c, { allowExpired: true })
  if (!object) return error!
  await deleteObjectData(c.env, object)
  return ok(c, { cancelled: true })
})

type SessionLookup = { object: VaultObjectRecord; error?: undefined } | { object?: undefined; error: Response }

async function uploadSession(
  c: Context<AppEnv>,
  options: { allowExpired?: boolean } = {}
): Promise<SessionLookup> {
  const session = getSession(c)
  const object = await getObject(c.env, c.req.param('id') ?? '')
  if (!object || object.status !== 'uploading') {
    return { error: fail(c, 'Upload session not found', 404) }
  }
  if (object.owner !== session.userId) {
    return { error: fail(c, 'Not your upload', 403) }
  }
  // Enforce expiry here so commit cannot race the sweep.
  if (!options.allowExpired && object.expires_at && object.expires_at < new Date().toISOString()) {
    return { error: fail(c, 'This upload expired; start it again', 410) }
  }
  return { object }
}

async function readExactBody(
  request: Request,
  expected: number
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
