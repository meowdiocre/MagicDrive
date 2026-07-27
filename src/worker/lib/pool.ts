import { HTTPException } from 'hono/http-exception'
import { createDriver } from '../drivers/registry'
import { findFolder } from '../drivers/tree'
import { escapeLike, normalizeVirtualPath } from './path'
import type { Bindings, DriveRecord, PoolFolderRecord } from '../types'

const POOL_COLUMNS = 'id, path, name, parent_path, created_by, access_mode, access_password_hash'

export function isPoolContributor(drive: Pick<DriveRecord, 'pool_contributor'>): boolean {
  return drive.pool_contributor !== 0
}

export function poolProviderRoot(driveId: string): string {
  const safeId = driveId.replace(/[^A-Za-z0-9_-]/g, '_')
  return `/.magicdrive-pool-${safeId}`
}

export function poolProviderPath(driveId: string, virtualPath: string): string {
  const cleanPath = normalizeVirtualPath(virtualPath)
  return cleanPath === '/' ? poolProviderRoot(driveId) : `${poolProviderRoot(driveId)}${cleanPath}`
}

export async function loadPoolRoots(db: D1Database): Promise<PoolFolderRecord[]> {
  const rows = await db.prepare(
    `SELECT ${POOL_COLUMNS} FROM pool_folders WHERE parent_path = '/' ORDER BY name ASC`
  ).all<PoolFolderRecord>()
  return rows.results ?? []
}

/** List virtual children even when they are empty or their providers are unreachable. */
export async function loadPoolChildren(db: D1Database, parentPath: string): Promise<PoolFolderRecord[]> {
  const rows = await db.prepare(
    `SELECT ${POOL_COLUMNS} FROM pool_folders WHERE parent_path = ? ORDER BY name ASC`
  ).bind(parentPath).all<PoolFolderRecord>()
  return rows.results ?? []
}

/**
 * Connections explicitly attached to the nearest conjured ancestor. A raw
 * provider folder below that ancestor inherits its membership; a connection
 * added later inherits nothing merely because the same path happens to exist.
 */
export async function loadPoolDriveIds(db: D1Database, path: string): Promise<string[]> {
  const rows = await db.prepare(
    `SELECT membership.drive_id
     FROM pool_folder_drives membership
     JOIN pool_folders folder ON folder.id = membership.folder_id
     WHERE folder.path = (
       SELECT candidate.path
       FROM pool_folders candidate
       WHERE candidate.path = ?1
          OR substr(?1, 1, length(candidate.path) + 1) = candidate.path || '/'
       ORDER BY length(candidate.path) DESC
       LIMIT 1
     )`
  ).bind(path).all<{ drive_id: string }>()
  return (rows.results ?? []).map(row => row.drive_id)
}

export async function insertPoolFolder(
  db: D1Database,
  folder: { path: string; name: string; parentPath: string; userId: string | null },
  driveIds: string[]
): Promise<void> {
  const now = new Date().toISOString()
  const statements = [
    db.prepare(
      `INSERT INTO pool_folders (id, path, name, parent_path, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO NOTHING`
    ).bind(crypto.randomUUID(), folder.path, folder.name, folder.parentPath, folder.userId, now),
    ...[...new Set(driveIds)].map(driveId => db.prepare(
      `INSERT OR IGNORE INTO pool_folder_drives (folder_id, drive_id, created_at)
       SELECT id, ?, ? FROM pool_folders WHERE path = ?`
    ).bind(driveId, now, folder.path)),
  ]
  await db.batch(statements)
}

export async function removePoolSubtree(db: D1Database, path: string): Promise<void> {
  await db.prepare(
    "DELETE FROM pool_folders WHERE path = ? OR path LIKE ? ESCAPE '\\'"
  ).bind(path, `${escapeLike(path)}/%`).run()
}

/** Journal failed provider removals so stale folders can be retried. */
export async function journalPoolDeletion(db: D1Database, driveId: string, parentPath: string, name: string): Promise<void> {
  await db.prepare(
    'INSERT INTO pool_deletions (id, drive_id, parent_path, name, attempts, created_at) VALUES (?, ?, ?, ?, 0, ?)'
  ).bind(crypto.randomUUID(), driveId, parentPath, name, new Date().toISOString()).run()
}

/** A retry must finish before this provider path can safely be reused. */
export async function assertNoPoolDeletion(db: D1Database, parentPath: string, name: string): Promise<void> {
  const pending = await db.prepare(
    'SELECT 1 AS present FROM pool_deletions WHERE parent_path = ? AND name = ? LIMIT 1'
  ).bind(parentPath, name).first<{ present: number }>()
  if (pending) {
    throw new HTTPException(409, {
      message: `“${name}” is still being removed from a storage. Try again after cleanup finishes.`,
    })
  }
}

const RETRY_BATCH = 25

export async function retryPoolDeletions(env: Bindings): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id, drive_id, parent_path, name, attempts FROM pool_deletions
     ORDER BY attempts ASC, created_at ASC LIMIT ?`
  ).bind(RETRY_BATCH).all<{ id: string; drive_id: string; parent_path: string; name: string; attempts: number }>()
  let settled = 0
  for (const entry of rows.results ?? []) {
    // The path may have been conjured again since; that folder is live now.
    const revived = await env.DB.prepare(
      'SELECT 1 AS present FROM pool_folders WHERE parent_path = ? AND name = ? LIMIT 1'
    ).bind(entry.parent_path, entry.name).first<{ present: number }>()
    if (revived) {
      await env.DB.prepare('DELETE FROM pool_deletions WHERE id = ?').bind(entry.id).run()
      continue
    }
    const drive = await env.DB.prepare(
      `SELECT id, user_id, provider, provider_variant, name, root_id, refresh_token_enc,
              config_enc, granted_scope, access_mode, access_password_hash, pool_contributor
       FROM drives WHERE id = ?`
    ).bind(entry.drive_id).first<DriveRecord>()
    try {
      if (drive) {
        const driver = createDriver(env, drive)
        const folder = await findFolder(driver, poolProviderPath(entry.drive_id, entry.parent_path), entry.name)
        if (folder) await driver.remove(folder.id)
      }
      await env.DB.prepare('DELETE FROM pool_deletions WHERE id = ?').bind(entry.id).run()
      settled += 1
    } catch {
      await env.DB.prepare('UPDATE pool_deletions SET attempts = attempts + 1 WHERE id = ?').bind(entry.id).run()
    }
  }
  return settled
}
