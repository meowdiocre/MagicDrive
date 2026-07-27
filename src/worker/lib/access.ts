import { hmacSha256, randomToken, toHex } from './crypto'
import type { DriveRecord, StorageAccessMode } from '../types'

const ACCESS_MODES = new Set<StorageAccessMode>(['public', 'protected', 'private'])
const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 200

export function driveAccessMode(drive: DriveRecord): StorageAccessMode {
  return drive.access_mode && ACCESS_MODES.has(drive.access_mode) ? drive.access_mode : 'public'
}

export async function prepareStorageAccess(
  secret: string,
  modeValue: unknown,
  passwordValue: unknown,
): Promise<
  | { mode: StorageAccessMode; passwordHash: string | null }
  | { error: string }
> {
  const mode = modeValue === undefined ? 'public' : modeValue
  if (typeof mode !== 'string' || !ACCESS_MODES.has(mode as StorageAccessMode)) {
    return { error: 'Invalid storage access mode' }
  }
  if (mode !== 'protected') return { mode: mode as StorageAccessMode, passwordHash: null }
  if (typeof passwordValue !== 'string' || passwordValue.length < MIN_PASSWORD_LENGTH) {
    return { error: `Storage password must be at least ${MIN_PASSWORD_LENGTH} characters` }
  }
  if (passwordValue.length > MAX_PASSWORD_LENGTH) {
    return { error: `Storage password must be at most ${MAX_PASSWORD_LENGTH} characters` }
  }
  return { mode, passwordHash: await hashStorageAccessPassword(secret, passwordValue) }
}

export async function hashStorageAccessPassword(secret: string, password: string): Promise<string> {
  const salt = randomToken(16)
  const digest = toHex(await hmacSha256(secret, `magicdrive:storage-access:v1:${salt}:${password}`))
  return `v1.${salt}.${digest}`
}

export async function verifyStorageAccessPassword(
  secret: string,
  password: string,
  stored: string,
): Promise<boolean> {
  const [version, salt, expected] = stored.split('.')
  if (version !== 'v1' || !salt || !expected) return false
  const actual = toHex(await hmacSha256(secret, `magicdrive:storage-access:v1:${salt}:${password}`))
  return constantTimeEqual(actual, expected)
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length)
  let different = left.length ^ right.length
  for (let index = 0; index < length; index += 1) {
    different |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return different === 0
}
