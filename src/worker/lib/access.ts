import { hmacSha256, randomToken, toHex } from './crypto'
import type { DriveRecord, StorageAccessMode } from '../types'

const ACCESS_MODES = new Set<StorageAccessMode>(['public', 'protected', 'private'])
const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 200
const HASH_VERSION = 'v2'
const LEGACY_HASH_VERSION = 'v1'

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
  return prepareAccess(secret, 'Storage', modeValue, passwordValue)
}

export async function prepareAccess(
  secret: string,
  subject: 'Storage' | 'Folder',
  modeValue: unknown,
  passwordValue: unknown,
): Promise<
  | { mode: StorageAccessMode; passwordHash: string | null }
  | { error: string }
> {
  const mode = modeValue === undefined ? 'public' : modeValue
  if (typeof mode !== 'string' || !ACCESS_MODES.has(mode as StorageAccessMode)) {
    return { error: `Invalid ${subject.toLowerCase()} access mode` }
  }
  if (mode !== 'protected') return { mode: mode as StorageAccessMode, passwordHash: null }
  if (typeof passwordValue !== 'string' || passwordValue.length < MIN_PASSWORD_LENGTH) {
    return { error: `${subject} password must be at least ${MIN_PASSWORD_LENGTH} characters` }
  }
  if (passwordValue.length > MAX_PASSWORD_LENGTH) {
    return { error: `${subject} password must be at most ${MAX_PASSWORD_LENGTH} characters` }
  }
  return { mode, passwordHash: await hashAccessPassword(secret, passwordValue) }
}

export async function hashAccessPassword(secret: string, password: string): Promise<string> {
  const salt = randomToken(16)
  const digest = toHex(await hmacSha256(secret, `magicdrive:access:${HASH_VERSION}:${salt}:${password}`))
  return `${HASH_VERSION}.${salt}.${digest}`
}

export async function verifyAccessPassword(
  secret: string,
  password: string,
  stored: string,
): Promise<boolean> {
  const [version, salt, expected] = stored.split('.')
  if (!salt || !expected) return false
  const value = version === HASH_VERSION
    ? `magicdrive:access:${HASH_VERSION}:${salt}:${password}`
    : version === LEGACY_HASH_VERSION
      ? `magicdrive:storage-access:${LEGACY_HASH_VERSION}:${salt}:${password}`
      : null
  if (!value) return false
  const actual = toHex(await hmacSha256(secret, value))
  return constantTimeEqual(actual, expected)
}

export const hashStorageAccessPassword = hashAccessPassword
export const verifyStorageAccessPassword = verifyAccessPassword

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length)
  let different = left.length ^ right.length
  for (let index = 0; index < length; index += 1) {
    different |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return different === 0
}
