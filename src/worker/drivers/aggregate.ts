import { HTTPException } from 'hono/http-exception'
import { createDriver } from './registry'
import type { Capability, StorageDriver } from './contract'
import { decodeBase64UrlUtf8, encodeBase64UrlUtf8 } from '../lib/base64'
import { hmacSha256, toHex } from '../lib/crypto'
import {
  assertNoPoolDeletion, insertPoolFolder, journalPoolDeletion,
  loadPoolChildren, loadPoolDriveIds, poolProviderPath, removePoolSubtree,
} from '../lib/pool'
import { pickPlacement, release, reserve, reservedBytes } from '../lib/placement'
import { driveStatus, invalidateStatus } from '../lib/status'
import { joinVirtualPath, normalizeVirtualPath, pathParts } from '../lib/path'
import { ensureFolder, ensurePath, findFolder, findFolderNamed, surveyFolder } from './tree'
import type { Bindings, DriveRecord, FileItem, ListResult, PoolFolderRecord } from '../types'

export const GLOBAL_DRIVE_ID = 'global'

export const POOL_NAME = 'The Cauldron'

/** A folder that spans every connection, rather than living on any one of them. */
export const POOL_FOLDER_MIME = 'application/vnd.magicdrive.pooled-folder'

// `pool` addresses virtual folders; `pool:<driveId>` addresses HMAC-tagged files.
const POOL_ID = 'pool'
const POOL_FILE_PREFIX = 'pool:'
const TAG_LENGTH = 16

const POOL_MERGE_PAGES = 4
const POOL_SEARCH_MAX_DEPTH = 12
const POOL_SEARCH_MAX_ITEMS = 1000

const READ_ONLY: readonly Capability[] = ['list', 'search', 'download', 'thumbnail']
const FULL: readonly Capability[] = [...READ_ONLY, 'upload', 'mkdir', 'delete', 'rename']

export interface PoolActor {
  userId: string | null
  isMagician: boolean
}

/** Per-connection outcome of a fan-out, so a partial result can be reported honestly. */
export interface PoolTarget {
  storage: string
  ok: boolean
  error?: string
}

/** Public merged reads; only Magicians can write inside verified pool folders. */
export class AggregateDriver implements StorageDriver {
  readonly capabilities = FULL

  private readonly roots: Map<string, PoolFolderRecord>

  constructor(
    private readonly env: Bindings,
    private readonly drives: DriveRecord[],
    roots: PoolFolderRecord[],
    private readonly actor: PoolActor
  ) {
    this.roots = new Map(roots.map(root => [root.name, root]))
  }

  allowed(path: string): readonly Capability[] {
    if (!this.actor.isMagician) return READ_ONLY
    const parts = pathParts(path)
    if (parts.length === 0) return [...READ_ONLY, 'mkdir']
    return this.rootFor(parts[0]) === null ? READ_ONLY : FULL
  }

  private rootFor(segment: string): string | null {
    if (this.roots.has(segment)) return segment
    const wanted = segment.toLowerCase()
    return [...this.roots.keys()].find(name => name.toLowerCase() === wanted) ?? null
  }

  /** Canonicalize virtual segments because pool names are case-insensitive but providers are not. */
  private async pooledPath(path: string): Promise<string | null> {
    const parts = pathParts(path)
    if (parts.length === 0) return null
    const root = this.rootFor(parts[0])
    if (root === null) return null

    const resolved = [root]
    for (const segment of parts.slice(1)) {
      const parent = `/${resolved.join('/')}`
      const children = await loadPoolChildren(this.env.DB, parent)
      const wanted = segment.toLowerCase()
      resolved.push(children.find(child => child.name.toLowerCase() === wanted)?.name ?? segment)
    }
    return `/${resolved.join('/')}`
  }

  async list(path: string, pageToken?: string | null): Promise<ListResult> {
    const cleanPath = normalizeVirtualPath(path)
    const parts = pathParts(cleanPath)
    if (parts.length === 0) return this.listRoot()
    const pooled = await this.pooledPath(cleanPath)
    if (pooled !== null) return this.listPooled(pooled)
    throw new HTTPException(404, { message: 'Pool folder not found' })
  }

  private listRoot(): ListResult {
    const conjured = [...this.roots.values()].map(root => poolFolderItem(root.path, root.name))
    return { path: '/', items: conjured, nextPageToken: null }
  }

  /** Merge verified member listings; bounded walks report `truncated`. */
  private async listPooled(path: string): Promise<ListResult> {
    const drives = await this.poolDrives(path)
    const readings = await Promise.all(drives.map(async drive => {
      const collected: FileItem[] = []
      let pageToken: string | null = null
      try {
        const driver = createDriver(this.env, drive)
        const providerPath = poolProviderPath(drive.id, path)
        for (let page = 0; page < POOL_MERGE_PAGES; page += 1) {
          const result: ListResult = await driver.list(providerPath, pageToken)
          collected.push(...result.items)
          pageToken = result.nextPageToken
          if (!pageToken) break
        }
      } catch {
        // An unreachable member must not blank out the whole folder.
        return { drive, collected, more: false }
      }
      return { drive, collected, more: pageToken !== null }
    }))

    const items: FileItem[] = []
    const claimed = new Set<string>()
    for (const child of await loadPoolChildren(this.env.DB, path)) {
      claimed.add(child.name.toLowerCase())
      items.push(poolFolderItem(child.path, child.name))
    }
    for (const reading of readings) {
      for (const item of reading.collected) {
        const key = item.name.toLowerCase()
        // The first member claiming a name owns it in the merged namespace.
        if (claimed.has(key)) continue
        claimed.add(key)
        items.push(item.isFolder
          ? poolFolderItem(joinVirtualPath(path, item.name), item.name, item)
          : { ...item, id: await encodePoolFileId(this.env.DATA_ENCRYPTION_KEY, reading.drive.id, item.id) })
      }
    }
    items.sort((left, right) => Number(right.isFolder) - Number(left.isFolder) || left.name.localeCompare(right.name))

    return { path, items, nextPageToken: null, truncated: readings.some(reading => reading.more) }
  }

  async search(query: string): Promise<FileItem[]> {
    const wanted = query.trim().toLowerCase()
    if (!wanted) return []
    const results: FileItem[] = []
    const claimed = new Set<string>()
    for (const root of this.roots.values()) {
      if (results.length >= POOL_SEARCH_MAX_ITEMS) break
      for (const drive of await this.poolDrives(root.path)) {
        if (results.length >= POOL_SEARCH_MAX_ITEMS) break
        try {
          await this.searchDrive(drive, root.path, wanted, results, claimed)
        } catch {
          // One unreachable contributor must not blank out the pool search.
        }
      }
    }
    return results
  }

  private async searchDrive(
    drive: DriveRecord,
    rootPath: string,
    wanted: string,
    results: FileItem[],
    claimed: Set<string>,
  ): Promise<void> {
    const driver = createDriver(this.env, drive)
    const queue: Array<{ path: string; depth: number }> = [{ path: rootPath, depth: 0 }]
    while (queue.length > 0 && results.length < POOL_SEARCH_MAX_ITEMS) {
      const current = queue.shift()!
      let pageToken: string | null = null
      for (let page = 0; page < POOL_MERGE_PAGES && results.length < POOL_SEARCH_MAX_ITEMS; page += 1) {
        const listing = await driver.list(poolProviderPath(drive.id, current.path), pageToken)
        for (const item of listing.items) {
          const virtualPath = joinVirtualPath(current.path, item.name)
          if (item.isFolder && current.depth < POOL_SEARCH_MAX_DEPTH) {
            queue.push({ path: virtualPath, depth: current.depth + 1 })
          }
          if (!item.name.toLowerCase().includes(wanted) || claimed.has(virtualPath.toLowerCase())) continue
          claimed.add(virtualPath.toLowerCase())
          results.push(item.isFolder
            ? poolFolderItem(virtualPath, item.name, item)
            : { ...item, id: await encodePoolFileId(this.env.DATA_ENCRYPTION_KEY, drive.id, item.id) })
        }
        pageToken = listing.nextPageToken
        if (!pageToken) break
      }
    }
  }

  async download(fileId: string, request: Request, disposition?: 'attachment' | 'inline'): Promise<Response> {
    const { drive, id } = await this.target(fileId)
    return createDriver(this.env, drive).download(id, request, disposition)
  }

  async thumbnail(fileId: string): Promise<Response> {
    const { drive, id } = await this.target(fileId)
    return createDriver(this.env, drive).thumbnail(id)
  }

  async mkdir(path: string, name: string): Promise<FileItem> {
    return (await this.conjureFolder(path, name)).item
  }

  /** Create the virtual folder on verified members and report partial failures. */
  async conjureFolder(path: string, name: string): Promise<{ item: FileItem; storages: PoolTarget[] }> {
    const parts = pathParts(path)
    const cleanPath = parts.length === 0 ? '/' : await this.pooledPath(path) ?? ''
    if (!cleanPath) {
      throw new HTTPException(403, {
        message: `Folders here belong to ${POOL_NAME}. Switch to that storage to add folders inside it.`,
      })
    }
    if (parts.length === 0) this.assertRootNameFree(name)
    const drives = parts.length === 0 ? this.drives : await this.poolDrives(cleanPath)
    if (drives.length === 0) {
      throw new HTTPException(404, { message: 'No storage is connected yet' })
    }
    await assertNoPoolDeletion(this.env.DB, cleanPath, name)
    // Never adopt an existing contributor folder as a new pool root.
    const unverified = new Map<string, string>()
    if (parts.length === 0) {
      const adopted = await Promise.all(drives.map(async drive => {
        try {
          const driver = createDriver(this.env, drive)
          const providerRoot = poolProviderPath(drive.id, '/')
          await ensurePath(driver, providerRoot)
          return await findFolderNamed(driver, providerRoot, name) ? drive.name : null
        } catch (cause) {
          unverified.set(drive.id, reason(cause))
          return null
        }
      }))
      const holder = adopted.find(entry => entry !== null)
      if (holder) {
        throw new HTTPException(409, {
          message: `“${name}” already exists on ${holder}. Pick a name no connected storage is using.`,
        })
      }
    }

    const attempts = await Promise.all(drives.map(async drive => {
      const verificationError = unverified.get(drive.id)
      if (verificationError) {
        return { drive, storage: drive.name, ok: false, error: `could not verify the folder name: ${verificationError}` }
      }
      const driver = createDriver(this.env, drive)
      const providerPath = poolProviderPath(drive.id, cleanPath)
      if (!driver.capabilities.includes('mkdir')) {
        return { drive, storage: drive.name, ok: false, error: 'connection is read-only' }
      }
      try {
        await ensurePath(driver, providerPath)
        await ensureFolder(driver, providerPath, name)
        return { drive, storage: drive.name, ok: true }
      } catch (cause) {
        return { drive, storage: drive.name, ok: false, error: reason(cause) }
      }
    }))

    if (attempts.every(target => !target.ok)) {
      throw new HTTPException(502, {
        message: `Could not create “${name}” on any connected storage: ${attempts[0].error}`,
      })
    }

    const target = joinVirtualPath(cleanPath, name)
    await insertPoolFolder(this.env.DB, {
      path: target,
      name,
      parentPath: cleanPath,
      userId: this.actor.userId,
    }, attempts.filter(attempt => attempt.ok).map(attempt => attempt.drive.id))
    const storages = attempts.map(({ drive: _drive, ...attempt }) => attempt)
    return { item: poolFolderItem(target, name), storages }
  }

  async upload(
    path: string,
    filename: string,
    body: ReadableStream | ArrayBuffer,
    contentType: string,
    size: number
  ): Promise<FileItem> {
    const cleanPath = await this.pooledPath(path) ?? ''
    if (!cleanPath) {
      throw new HTTPException(403, { message: `Files can only be added inside a folder in ${POOL_NAME}.` })
    }

    const wanted = filename.toLowerCase()
    const drives = await this.poolDrives(cleanPath)
    const candidates = await Promise.all(drives.map(async drive => {
      const driver = createDriver(this.env, drive)
      if (!driver.capabilities.includes('upload')) return null
      const providerPath = poolProviderPath(drive.id, cleanPath)
      try {
        // Survey all bounded pages so visible names cannot be shadowed.
        const survey = await surveyFolder(driver, providerPath, wanted)
        return { drive, driver, providerPath, held: survey.count, taken: survey.taken, complete: survey.complete }
      } catch {
        // A failed survey proves neither availability nor pool membership.
        try {
          await ensurePath(driver, providerPath)
          return { drive, driver, providerPath, held: 0, taken: false, complete: false }
        } catch {
          return null
        }
      }
    }))
    if (candidates.some(entry => entry === null || !entry.complete)) {
      throw new HTTPException(503, {
        message: 'Could not verify every pooled storage for duplicate names. Retry when all folder listings are complete.',
      })
    }
    const usable = candidates.filter(entry => entry !== null)
    // Reject names already held anywhere in the merged namespace.
    const children = await loadPoolChildren(this.env.DB, cleanPath)
    if (usable.some(entry => entry.taken) || children.some(child => child.name.toLowerCase() === wanted)) {
      throw new HTTPException(409, { message: `“${filename}” already exists in this folder` })
    }

    const scored = await Promise.all(usable.map(async entry => {
      const status = await driveStatus(this.env, entry.drive)
      const free = status.usage?.freeBytes
      return {
        entry,
        healthy: status.health.ok,
        held: entry.held,
        freeBytes: free === null || free === undefined
          ? null
          : Math.max(0, free - await reservedBytes(this.env, entry.drive.id)),
      }
    }))
    const target = pickPlacement(scored, size)
    if (!target) {
      throw new HTTPException(507, { message: 'Every vault that reports its capacity is too full for this file' })
    }
    await reserve(this.env, target.drive.id, size)
    try {
      const item = await target.driver.upload(target.providerPath, filename, body, contentType, size)
      // Status is advisory; a KV fault must not turn a completed upload into a retry.
      await invalidateStatus(this.env, target.drive.id).catch(() => {})
      return { ...item, id: await encodePoolFileId(this.env.DATA_ENCRYPTION_KEY, target.drive.id, item.id) }
    } finally {
      // Failed writes must not reserve imaginary bytes.
      await release(this.env, target.drive.id, size).catch(() => {})
    }
  }

  async remove(fileId: string): Promise<void> {
    const { driveId, id } = decodeAggregateId(fileId)
    if (driveId === POOL_ID) return this.dispelFolder(id)
    const { drive, id: real } = await this.pooledFile(driveId, id, 'delete')
    await createDriver(this.env, drive).remove(real)
  }

  async rename(fileId: string, newName: string, path?: string): Promise<Pick<FileItem, 'id' | 'name'>> {
    const { driveId, id } = decodeAggregateId(fileId)
    if (driveId === POOL_ID) {
      throw new HTTPException(400, {
        message: `Folders in ${POOL_NAME} exist on every connection at once and cannot be renamed.`,
      })
    }
    const { drive, id: real } = await this.pooledFile(driveId, id, 'rename')
    if (!path) throw new HTTPException(400, { message: 'Open the containing pooled folder before renaming this file' })
    const cleanPath = await this.pooledPath(path)
    if (!cleanPath) throw new HTTPException(400, { message: 'Open the containing pooled folder before renaming this file' })
    const wanted = newName.toLowerCase()
    const surveys = await Promise.all((await this.poolDrives(cleanPath)).map(async drive => {
      try {
        const survey = await surveyFolder(
          createDriver(this.env, drive),
          poolProviderPath(drive.id, cleanPath),
          wanted,
        )
        if (survey.complete) return survey.taken
      } catch {
        // Fall through to the same safe refusal as a bounded, incomplete walk.
      }
      throw new HTTPException(503, { message: 'Could not verify every pooled storage for duplicate names' })
    }))
    if (surveys.some(Boolean)) throw new HTTPException(409, { message: `“${newName}” already exists in this folder` })
    const renamed = await createDriver(this.env, drive).rename(real, newName)
    return { id: await encodePoolFileId(this.env.DATA_ENCRYPTION_KEY, drive.id, renamed.id), name: renamed.name }
  }

  private async dispelFolder(path: string): Promise<void> {
    const cleanPath = await this.pooledPath(path) ?? ''
    if (!cleanPath) {
      throw new HTTPException(403, { message: `Only folders in ${POOL_NAME} can be removed from here.` })
    }
    const parts = pathParts(cleanPath)
    const name = parts[parts.length - 1]
    const parent = `/${parts.slice(0, -1).join('/')}`

    const drives = await this.poolDrives(cleanPath)
    const results = await Promise.all(drives.map(async drive => {
      const driver = createDriver(this.env, drive)
      try {
        const folder = await findFolder(driver, poolProviderPath(drive.id, parent), name)
        if (folder) await driver.remove(folder.id)
        return { drive, ok: true }
      } catch {
        return { drive, ok: false }
      }
    }))
    const failed = results.filter(result => !result.ok)
    if (drives.length > 0 && failed.length === drives.length) {
      throw new HTTPException(502, { message: `Could not remove “${name}” from any connected storage` })
    }
    // Remove the virtual row; failed provider removals are retried by cron.
    await Promise.all(failed.map(result => journalPoolDeletion(this.env.DB, result.drive.id, parent, name)))
    await removePoolSubtree(this.env.DB, cleanPath)
  }

  private assertRootNameFree(name: string): void {
    const wanted = name.toLowerCase()
    if ([...this.roots.keys()].some(existing => existing.toLowerCase() === wanted)) {
      throw new HTTPException(409, { message: `“${name}” already exists in ${POOL_NAME}` })
    }
  }

  private driveById(driveId: string): DriveRecord {
    const drive = this.drives.find(entry => entry.id === driveId)
    if (!drive) throw new HTTPException(404, { message: 'Storage not found' })
    return drive
  }

  private async poolDrives(path: string): Promise<DriveRecord[]> {
    const members = new Set(await loadPoolDriveIds(this.env.DB, path))
    return this.drives.filter(drive => members.has(drive.id))
  }

  /**
   * Resolve an HMAC-tagged pooled file. The tag proves issuance, not current path
   * membership, so a previously listed ID can outlive its virtual folder.
   */
  private async pooledFile(driveId: string, tagged: string, action: string): Promise<{ drive: DriveRecord; id: string }> {
    const refusal = new HTTPException(403, {
      message: `Switch to that storage to ${action} its own files; ${POOL_NAME} only manages what it holds.`,
    })
    if (!driveId.startsWith(POOL_FILE_PREFIX)) throw refusal
    const owner = driveId.slice(POOL_FILE_PREFIX.length)
    const id = await verifyPoolFileId(this.env.DATA_ENCRYPTION_KEY, owner, tagged)
    if (id === null) throw refusal
    return { drive: this.driveById(owner), id }
  }

  private async target(fileId: string): Promise<{ drive: DriveRecord; id: string }> {
    const { driveId, id } = decodeAggregateId(fileId)
    if (driveId === POOL_ID) throw new HTTPException(400, { message: 'Folders cannot be downloaded' })
    if (!driveId.startsWith(POOL_FILE_PREFIX)) throw new HTTPException(404, { message: 'Pool file not found' })
    const owner = driveId.slice(POOL_FILE_PREFIX.length)
    const real = await verifyPoolFileId(this.env.DATA_ENCRYPTION_KEY, owner, id)
    if (real === null) throw new HTTPException(404, { message: 'Pool file not found' })
    return { drive: this.driveById(owner), id: real }
  }
}

function poolFolderItem(path: string, name: string, source?: FileItem): FileItem {
  return {
    id: encodePoolId(path),
    name,
    mimeType: POOL_FOLDER_MIME,
    size: null,
    modifiedTime: source?.modifiedTime ?? null,
    createdTime: source?.createdTime ?? null,
    thumbnailLink: null,
    isFolder: true,
  }
}

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'unknown error'
}

// Ids stay within the base64url alphabet so they survive the same validation as
// real provider ids.
export function encodeAggregateId(driveId: string, fileId: string): string {
  return encodeBase64UrlUtf8(`${driveId}|${fileId}`)
}

export function decodeAggregateId(value: string): { driveId: string; id: string } {
  let decoded: string
  try {
    decoded = decodeBase64UrlUtf8(value)
  } catch {
    throw new HTTPException(400, { message: 'Invalid file ID' })
  }
  const separator = decoded.indexOf('|')
  if (separator < 1) throw new HTTPException(400, { message: 'Invalid file ID' })
  return { driveId: decoded.slice(0, separator), id: decoded.slice(separator + 1) }
}

export function encodePoolId(path: string): string {
  return encodeAggregateId(POOL_ID, path)
}

async function poolTag(secret: string, driveId: string, fileId: string): Promise<string> {
  return toHex(await hmacSha256(`magicdrive:pool:v1:${secret}`, `${driveId}|${fileId}`)).slice(0, TAG_LENGTH)
}

export async function encodePoolFileId(secret: string, driveId: string, fileId: string): Promise<string> {
  return encodeAggregateId(`${POOL_FILE_PREFIX}${driveId}`, `${fileId}|${await poolTag(secret, driveId, fileId)}`)
}

/** Null when the tag is absent or does not match, which means the id was made up. */
export async function verifyPoolFileId(secret: string, driveId: string, tagged: string): Promise<string | null> {
  const separator = tagged.lastIndexOf('|')
  if (separator < 1) return null
  const fileId = tagged.slice(0, separator)
  const tag = tagged.slice(separator + 1)
  const expected = await poolTag(secret, driveId, fileId)
  if (tag.length !== expected.length) return null
  // Length is public; the comparison itself stays constant-time.
  let diff = 0
  for (let index = 0; index < expected.length; index += 1) diff |= tag.charCodeAt(index) ^ expected.charCodeAt(index)
  return diff === 0 ? fileId : null
}
