import type { Bindings } from '../types'

/** Keep headroom so a full vault does not break its owner's use of it. */
export const RESERVE_BYTES = 256 * 1024 * 1024

const RESERVATION_TTL = 600

export interface PlacementCandidate<T> {
  entry: T
  /** Known free space minus outstanding reservations; null when the provider cannot say. */
  freeBytes: number | null
  healthy: boolean
  /** Tiebreak for providers without quota: how much this location already holds. */
  held: number
}

/** Prefer the roomiest proven vault; use least-held unknown-quota vaults as fallback. */
export function pickPlacement<T>(
  candidates: PlacementCandidate<T>[],
  sizeBytes: number,
  reserveBytes = RESERVE_BYTES
): T | null {
  const eligible = candidates.filter(candidate =>
    candidate.healthy && (candidate.freeBytes === null || candidate.freeBytes - sizeBytes >= reserveBytes)
  )
  if (eligible.length === 0) return null
  const known = eligible.filter(candidate => candidate.freeBytes !== null)
  if (known.length > 0) {
    return known.reduce((best, next) => (next.freeBytes! > best.freeBytes! ? next : best)).entry
  }
  return eligible.reduce((best, next) => (next.held < best.held ? next : best)).entry
}

const reservationKey = (driveId: string) => `resv:${driveId}`

export async function reservedBytes(env: Bindings, driveId: string): Promise<number> {
  return Number(await env.SESSIONS.get(reservationKey(driveId))) || 0
}

/**
 * Best-effort guard against simultaneous uploads all picking the same vault.
 * KV is last-write-wins, so a race can undercount; the reserve floor absorbs it.
 */
export async function reserve(env: Bindings, driveId: string, sizeBytes: number): Promise<void> {
  const current = await reservedBytes(env, driveId)
  await env.SESSIONS.put(reservationKey(driveId), String(current + sizeBytes), {
    expirationTtl: RESERVATION_TTL,
  })
}

export async function release(env: Bindings, driveId: string, sizeBytes: number): Promise<void> {
  const remaining = Math.max(0, await reservedBytes(env, driveId) - sizeBytes)
  if (remaining === 0) {
    await env.SESSIONS.delete(reservationKey(driveId))
    return
  }
  await env.SESSIONS.put(reservationKey(driveId), String(remaining), { expirationTtl: RESERVATION_TTL })
}
