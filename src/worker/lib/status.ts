import { createDriver } from '../drivers/registry'
import type { StorageUsage } from '../drivers/contract'
import type { Bindings, DriveRecord } from '../types'

export interface DriveStatus {
  usage: StorageUsage | null
  health: { ok: boolean; message?: string }
  checkedAt: string
}

const TTL_SECONDS = 1800
const PROBE_TIMEOUT_MS = 10_000
const key = (driveId: string) => `status:${driveId}`

/**
 * Quota and reachability in one probe, cached in KV so a page load never fans
 * out to every provider. getUsage doubles as the health check where it exists;
 * a bare listing stands in where it does not.
 */
export async function driveStatus(env: Bindings, drive: DriveRecord): Promise<DriveStatus> {
  const cached = await env.SESSIONS.get(key(drive.id))
  if (cached) {
    try {
      return JSON.parse(cached) as DriveStatus
    } catch {
      // Fall through to a fresh probe.
    }
  }

  const status: DriveStatus = { usage: null, health: { ok: true }, checkedAt: new Date().toISOString() }
  try {
    const driver = createDriver(env, drive)
    if (driver.getUsage) status.usage = await withTimeout(driver.getUsage(), PROBE_TIMEOUT_MS)
    else await withTimeout(driver.list('/'), PROBE_TIMEOUT_MS)
  } catch (cause) {
    status.health = { ok: false, message: cause instanceof Error ? cause.message : 'unreachable' }
  }
  await env.SESSIONS.put(key(drive.id), JSON.stringify(status), { expirationTtl: TTL_SECONDS })
  return status
}

export async function invalidateStatus(env: Bindings, driveId: string): Promise<void> {
  await env.SESSIONS.delete(key(driveId))
}

export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Storage probe timed out')), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
