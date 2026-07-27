import { hasFolderUnlock, type FolderSpace } from '../auth/session'
import { HTTPException } from 'hono/http-exception'
import { prepareAccess, verifyAccessPassword } from './access'
import type { Bindings, StorageAccessMode } from '../types'

const MAX_LEGACY_PBKDF2_ITERATIONS = 500_000
const encoder = new TextEncoder()

export interface FolderPolicy {
  id: string
  path: string
  owner: string | null
  access_mode: StorageAccessMode
  access_password_hash: string | null
}

export interface FolderAccessState {
  hidden: boolean
  locked: boolean
}

export async function prepareFolderAccess(
  secret: string,
  modeValue: unknown,
  passwordValue: unknown,
): Promise<{ mode: StorageAccessMode; passwordHash: string | null } | { error: string }> {
  return prepareAccess(secret, 'Folder', modeValue, passwordValue)
}

export async function verifyFolderPassword(secret: string, password: string, stored: string): Promise<boolean> {
  if (!stored.startsWith('v2.pbkdf2.')) return verifyAccessPassword(secret, password, stored)
  const [version, algorithm, iterationsText, saltText, digestText] = stored.split('.')
  const iterations = Number(iterationsText)
  if (
    version !== 'v2'
    || algorithm !== 'pbkdf2'
    || !Number.isSafeInteger(iterations)
    || iterations < 100_000
    || iterations > MAX_LEGACY_PBKDF2_ITERATIONS
  ) return false
  try {
    const salt = base64UrlToBytes(saltText)
    const expected = base64UrlToBytes(digestText)
    const actual = await derive(secret, password, salt, iterations)
    return constantTimeEqual(actual, expected)
  } catch {
    return false
  }
}

async function derive(secret: string, password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`${secret}\u0000${password}`),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: Uint8Array.from(salt), iterations, hash: 'SHA-256' },
    key,
    256,
  ))
}

export async function listFolderPolicies(env: Bindings, space: FolderSpace, path: string): Promise<FolderPolicy[]> {
  const table = space === 'pool' ? 'pool_folders' : 'vault_objects'
  const kind = space === 'pool' ? '' : " AND kind = 'folder'"
  const owner = space === 'pool' ? 'created_by' : 'owner'
  const rows = await env.DB.prepare(
    `SELECT id, path, ${owner} AS owner,
            access_mode, access_password_hash
       FROM ${table}
      WHERE (path = ? OR (
        substr(?, 1, length(path)) = path
        AND substr(?, length(path) + 1, 1) = '/'
      ))${kind}
      ORDER BY length(path) ASC`
  ).bind(path, path, path).all<FolderPolicy>()
  return rows.results ?? []
}

export async function getFolderPolicy(env: Bindings, space: FolderSpace, id: string): Promise<FolderPolicy | null> {
  const table = space === 'pool' ? 'pool_folders' : 'vault_objects'
  const kind = space === 'pool' ? '' : " AND kind = 'folder'"
  const owner = space === 'pool' ? 'created_by' : 'owner'
  return env.DB.prepare(
    `SELECT id, path, ${owner} AS owner,
            access_mode, access_password_hash
       FROM ${table}
      WHERE id = ?${kind}`
  ).bind(id).first<FolderPolicy>()
}

export async function getFolderPolicyByPath(
  env: Bindings,
  space: FolderSpace,
  path: string,
): Promise<FolderPolicy | null> {
  const table = space === 'pool' ? 'pool_folders' : 'vault_objects'
  const kind = space === 'pool' ? '' : " AND kind = 'folder'"
  const owner = space === 'pool' ? 'created_by' : 'owner'
  return env.DB.prepare(
    `SELECT id, path, ${owner} AS owner, access_mode, access_password_hash
       FROM ${table} WHERE path = ?${kind}`
  ).bind(path).first<FolderPolicy>()
}

export async function assertFolderReadable(
  env: Bindings,
  space: FolderSpace,
  path: string,
  request: Request | null,
  userId: string | null,
  bypass = false,
  privileged = false,
): Promise<void> {
  if (bypass) return
  const access = await folderAccess(env, space, path, request, userId, privileged)
  if (access.hidden) throw new HTTPException(404, { message: 'Folder not found' })
  if (access.locked) throw new HTTPException(423, { message: 'Folder password required' })
}

export async function folderAccess(
  env: Bindings,
  space: FolderSpace,
  path: string,
  request: Request | null,
  userId: string | null,
  privileged = false,
): Promise<FolderAccessState> {
  return evaluateFolderPolicies(env, space, await listFolderPolicies(env, space, path), request, userId, privileged)
}

export async function evaluateFolderPolicies(
  env: Bindings,
  space: FolderSpace,
  policies: FolderPolicy[],
  request: Request | null,
  userId: string | null,
  privileged = false,
): Promise<FolderAccessState> {
  let locked = false
  for (const policy of policies) {
    const privateDenied = space === 'pool'
      ? !privileged
      : !userId || policy.owner !== userId
    if (policy.access_mode === 'private' && privateDenied) {
      return { hidden: true, locked: true }
    }
    if (policy.access_mode === 'protected' && !(request && await hasFolderUnlock(request, env, space, policy.id, policy.access_password_hash))) {
      locked = true
    }
  }
  return { hidden: false, locked }
}

export function isFolderAccessError(error: unknown): boolean {
  return error instanceof HTTPException && (error.status === 404 || error.status === 423)
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!value) throw new Error('Invalid password hash')
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0))
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.byteLength, right.byteLength)
  let different = left.byteLength ^ right.byteLength
  for (let index = 0; index < length; index += 1) {
    different |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return different === 0
}
