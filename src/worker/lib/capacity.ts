import { createDriver } from '../drivers/registry'
import { driveStatus, type DriveStatus } from './status'
import type { Bindings, DriveRecord } from '../types'

export interface CapacitySummary {
  usedBytes: number | null
  totalBytes: number | null
  freeBytes: number | null
  knownStorages: number
  unknownStorages: number
  unavailableStorages: number
}

export function summarizeCapacity(statuses: DriveStatus[], unavailableStorages = 0): CapacitySummary {
  let totalBytes = 0
  let usedBytes = 0
  let freeBytes = 0
  let knownStorages = 0
  let unknownStorages = 0
  let usedComplete = true
  let freeComplete = true

  for (const status of statuses) {
    if (!status.health.ok) {
      unavailableStorages += 1
      continue
    }
    const usage = status.usage
    if (!usage || usage.totalBytes === null || usage.totalBytes <= 0) {
      unknownStorages += 1
      continue
    }
    knownStorages += 1
    totalBytes += usage.totalBytes

    const used = usage.usedBytes ?? (usage.freeBytes === null ? null : Math.max(0, usage.totalBytes - usage.freeBytes))
    const free = usage.freeBytes ?? (usage.usedBytes === null ? null : Math.max(0, usage.totalBytes - usage.usedBytes))
    if (used === null) usedComplete = false
    else usedBytes += used
    if (free === null) freeComplete = false
    else freeBytes += free
  }

  return {
    usedBytes: knownStorages > 0 && usedComplete ? usedBytes : null,
    totalBytes: knownStorages > 0 ? totalBytes : null,
    freeBytes: knownStorages > 0 && freeComplete ? freeBytes : null,
    knownStorages,
    unknownStorages,
    unavailableStorages,
  }
}

export async function capacityForDrives(
  env: Bindings,
  drives: DriveRecord[],
  unavailableStorages = 0,
): Promise<CapacitySummary> {
  const statuses = await Promise.all(drives.map(drive => driveStatus(env, drive)))
  return summarizeCapacity(statuses, unavailableStorages)
}

export function writableDrives(env: Bindings, drives: DriveRecord[]): { drives: DriveRecord[]; unavailableStorages: number } {
  const writable: DriveRecord[] = []
  let unavailableStorages = 0
  for (const drive of drives) {
    try {
      if (createDriver(env, drive).capabilities.includes('upload')) writable.push(drive)
      else unavailableStorages += 1
    } catch {
      unavailableStorages += 1
    }
  }
  return { drives: writable, unavailableStorages }
}
