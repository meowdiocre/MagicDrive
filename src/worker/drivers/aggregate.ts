import { HTTPException } from 'hono/http-exception'
import { decodeBase64UrlUtf8, encodeBase64UrlUtf8 } from '../lib/base64'
import { hmacSha256, sha256Hex, toHex } from '../lib/crypto'
import { assertFolderReadable, evaluateFolderPolicies, folderAccess, isFolderAccessError } from '../lib/folder-access'
import type { FolderAccessState } from '../lib/folder-access'
import { providerFileResponse } from '../lib/file-response'
import { isValidName, joinVirtualPath, normalizeVirtualPath, pathParts } from '../lib/path'
import {
  assertNoPoolDeletion, insertPoolFolder, loadPoolChildren, loadPoolDriveIds, removePoolSubtree,
} from '../lib/pool'
import {
  assertPoolParent, assertPoolPathFree, deletePoolObjectData, deletePoolSubtreeData, fetchPoolSegment,
  getPoolObject, insertPoolObject, listPoolObjects, listPoolSegments, searchPoolObjects, storePoolSegment,
} from '../lib/pool-vault'
import { CAULDRON_README, CAULDRON_README_ID, systemReadmeItem, systemReadmeResponse } from '../lib/readme'
import { decryptSegment, generateWrappedKey, unwrapKey } from '../lib/vault-crypto'
import { segmentSize } from '../lib/vault'
import { parseRange } from './vault'
import type { Capability, StorageDriver } from './contract'
import type { Bindings, DriveRecord, FileItem, ListResult, PoolFolderRecord, PoolObjectRecord, PoolSegmentRecord } from '../types'

export const GLOBAL_DRIVE_ID = 'global'
export const POOL_NAME = 'The Cauldron'
export const POOL_FOLDER_MIME = 'application/vnd.magicdrive.pool-folder'

const POOL_ID = 'pool'
const MANAGED_FILE_ID = 'managed'
const POOL_FILE_PREFIX = 'pool:'
const TAG_LENGTH = 16
const READ_ONLY: readonly Capability[] = ['list', 'search', 'download', 'thumbnail']
const FULL: readonly Capability[] = [...READ_ONLY, 'upload', 'mkdir', 'delete', 'rename']

export interface PoolActor {
  userId: string | null
  isMagician: boolean
}

/** Encrypted shared namespace. Providers receive opaque ciphertext pieces only. */
export class AggregateDriver implements StorageDriver {
  readonly capabilities = FULL
  private readonly roots: Map<string, PoolFolderRecord>

  constructor(
    private readonly env: Bindings,
    private readonly drives: DriveRecord[],
    roots: PoolFolderRecord[],
    private readonly actor: PoolActor,
    private readonly request: Request | null = null,
    private readonly bypassAccess = false,
  ) {
    this.roots = new Map(roots.map(root => [root.name, root]))
  }

  allowed(path: string): readonly Capability[] {
    if (!this.actor.isMagician) return READ_ONLY
    return pathParts(path).length === 0 ? [...READ_ONLY, 'mkdir'] : FULL
  }

  async list(path: string): Promise<ListResult> {
    const cleanPath = normalizeVirtualPath(path)
    if (cleanPath === '/') return this.listRoot()
    const folder = await this.folderAt(cleanPath)
    if (!folder) throw new HTTPException(404, { message: 'Pool folder not found' })
    await this.assertReadable(cleanPath)

    const folders = await loadPoolChildren(this.env.DB, cleanPath)
    const folderItems = (await Promise.all(folders.map(folder => this.folderItem(folder))))
      .filter((item): item is FileItem => item !== null)
    const files = (await listPoolObjects(this.env, cleanPath)).map(object => this.fileItem(object))
    const items = [...folderItems, ...files]
    items.sort((left, right) => Number(right.isFolder) - Number(left.isFolder) || left.name.localeCompare(right.name))
    return { path: cleanPath, items, nextPageToken: null }
  }

  private async listRoot(): Promise<ListResult> {
    const folders = (await Promise.all([...this.roots.values()].map(folder => this.folderItem(folder))))
      .filter((item): item is FileItem => item !== null)
    return {
      path: '/',
      items: [...folders, systemReadmeItem(CAULDRON_README_ID, CAULDRON_README)],
      nextPageToken: null,
    }
  }

  async search(query: string): Promise<FileItem[]> {
    const wanted = query.trim()
    if (wanted.length < 2) return []
    const [files, folders] = await Promise.all([
      searchPoolObjects(this.env, wanted),
      this.env.DB.prepare(
        `SELECT id, path, name, parent_path, created_by, access_mode, access_password_hash
           FROM pool_folders WHERE name LIKE ? ESCAPE '\\' COLLATE NOCASE
           ORDER BY name COLLATE NOCASE ASC LIMIT 20`
      ).bind(`%${wanted.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`)
        .all<PoolFolderRecord>(),
    ])
    const results: FileItem[] = []
    for (const folder of folders.results ?? []) {
      try {
        const access = await folderAccess(this.env, 'pool', folder.path, this.request, this.actor.userId, this.actor.isMagician)
        if (access.hidden || access.locked) continue
        const item = await this.folderItem(folder, access)
        if (item) results.push(item)
      } catch (error) {
        if (!isFolderAccessError(error)) throw error
      }
    }
    for (const object of files) {
      try {
        await this.assertReadable(object.parent_path)
        results.push(this.fileItem(object))
      } catch (error) {
        if (!isFolderAccessError(error)) throw error
      }
    }
    return results.slice(0, 100)
  }

  async download(fileId: string, request: Request, disposition: 'attachment' | 'inline' = 'attachment'): Promise<Response> {
    if (fileId === CAULDRON_README_ID) return systemReadmeResponse(CAULDRON_README, disposition)
    const object = await this.fileOrThrow(fileId)
    await this.assertReadable(object.parent_path)
    const segments = await listPoolSegments(this.env, object.id)
    if (segments.length === 0 || object.size <= 0) throw new HTTPException(500, { message: 'File has no stored content' })
    const key = await unwrapKey(this.env.DATA_ENCRYPTION_KEY, object.key_enc)
    const range = parseRange(request.headers.get('Range'), object.size)
    const [start, end] = range ?? [0, object.size - 1]
    const body = this.segmentStream(object, segments, key, start, end)
    const headers = new Headers({
      'Content-Type': object.content_type,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    })
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`)
    return providerFileResponse(new Response(body, { status: range ? 206 : 200, headers }), object.name, disposition)
  }

  private segmentStream(
    object: PoolObjectRecord,
    segments: PoolSegmentRecord[],
    key: CryptoKey,
    start: number,
    end: number,
  ): ReadableStream<Uint8Array> {
    const env = this.env
    const byIndex = new Map(segments.map(segment => [segment.idx, segment]))
    let index = Math.floor(start / object.segment_size)
    const lastIndex = Math.floor(end / object.segment_size)
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index > lastIndex) {
          controller.close()
          return
        }
        const segment = byIndex.get(index)
        if (!segment) {
          controller.error(new Error(`Missing segment ${index}`))
          return
        }
        try {
          const cipher = await fetchPoolSegment(env, segment)
          if (await sha256Hex(cipher) !== segment.sha256) throw new Error(`Segment ${index} failed its integrity check`)
          const plaintext = await decryptSegment(key, object.id, index, cipher)
          const offset = index * object.segment_size
          const from = Math.max(start - offset, 0)
          const to = Math.min(end - offset + 1, plaintext.byteLength)
          controller.enqueue(new Uint8Array(plaintext.slice(from, to)))
          index += 1
        } catch (cause) {
          controller.error(cause instanceof Error ? cause : new Error('Segment read failed'))
        }
      },
    })
  }

  async thumbnail(): Promise<Response> {
    return new Response('No thumbnail', { status: 404 })
  }

  async upload(
    path: string,
    filename: string,
    body: ReadableStream | ArrayBuffer,
    contentType: string,
    size: number,
  ): Promise<FileItem> {
    this.requireMagician('upload')
    const parentPath = normalizeVirtualPath(path)
    await this.assertReadable(parentPath)
    await assertPoolParent(this.env, parentPath)
    const target = joinVirtualPath(parentPath, filename)
    await assertPoolPathFree(this.env, target)
    const perSegment = segmentSize(this.env)
    if (size > perSegment) throw new HTTPException(413, { message: 'File is larger than one piece; use the chunked upload' })
    const bytes = body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer()
    if (bytes.byteLength !== size || size <= 0) throw new HTTPException(400, { message: 'Invalid upload size' })
    const object = await insertPoolObject(this.env, {
      parentPath,
      name: filename,
      path: target,
      owner: this.actor.userId!,
      size,
      contentType,
      keyEnc: await generateWrappedKey(this.env.DATA_ENCRYPTION_KEY),
      segmentSize: perSegment,
      uploading: true,
    })
    try {
      await storePoolSegment(this.env, object, 0, bytes)
      await this.env.DB.prepare(
        "UPDATE pool_objects SET status = 'ready', expires_at = NULL, updated_at = ? WHERE id = ?"
      ).bind(new Date().toISOString(), object.id).run()
      return this.fileItem({ ...object, status: 'ready', expires_at: null })
    } catch (cause) {
      await deletePoolObjectData(this.env, object)
      throw cause
    }
  }

  async mkdir(path: string, name: string): Promise<FileItem> {
    this.requireMagician('create folders')
    if (!isValidName(name)) throw new HTTPException(400, { message: 'Invalid folder name' })
    const parentPath = normalizeVirtualPath(path)
    if (parentPath !== '/') {
      if (!await this.folderAt(parentPath)) throw new HTTPException(404, { message: 'Pool folder not found' })
      await this.assertReadable(parentPath)
    }
    const target = joinVirtualPath(parentPath, name)
    await assertNoPoolDeletion(this.env.DB, parentPath, name)
    await assertPoolPathFree(this.env, target)
    const memberIds = parentPath === '/'
      ? this.drives.filter(drive => drive.pool_contributor !== 0).map(drive => drive.id)
      : await loadPoolDriveIds(this.env.DB, parentPath)
    if (memberIds.length === 0) throw new HTTPException(404, { message: 'No contributed storage is connected yet' })
    await insertPoolFolder(this.env.DB, {
      path: target,
      name,
      parentPath,
      userId: this.actor.userId,
    }, memberIds)
    const folder = await this.folderAt(target)
    if (!folder) throw new HTTPException(500, { message: 'Folder creation did not complete' })
    return (await this.folderItem(folder))!
  }

  async remove(fileId: string): Promise<void> {
    if (fileId === CAULDRON_README_ID) throw new HTTPException(403, { message: 'The Cauldron README is managed by MagicDrive' })
    this.requireMagician('delete')
    const { driveId, id } = decodeAggregateId(fileId)
    if (driveId === POOL_ID) return this.dispelFolder(id)
    if (driveId !== MANAGED_FILE_ID) throw new HTTPException(404, { message: 'Pool file not found' })
    const object = await getPoolObject(this.env, id)
    if (!object) throw new HTTPException(404, { message: 'Pool file not found' })
    await this.assertReadable(object.parent_path)
    await deletePoolObjectData(this.env, object)
  }

  async rename(fileId: string, newName: string): Promise<Pick<FileItem, 'id' | 'name'>> {
    this.requireMagician('rename')
    const { driveId, id } = decodeAggregateId(fileId)
    if (driveId === POOL_ID) throw new HTTPException(400, { message: 'Cauldron folders cannot be renamed yet' })
    if (driveId !== MANAGED_FILE_ID) throw new HTTPException(404, { message: 'Pool file not found' })
    const object = await getPoolObject(this.env, id)
    if (!object) throw new HTTPException(404, { message: 'Pool file not found' })
    await this.assertReadable(object.parent_path)
    const target = joinVirtualPath(object.parent_path, newName)
    if (target !== object.path) await assertPoolPathFree(this.env, target)
    await this.env.DB.prepare(
      'UPDATE pool_objects SET name = ?, path = ?, updated_at = ? WHERE id = ?'
    ).bind(newName, target, new Date().toISOString(), object.id).run()
    return { id: fileId, name: newName }
  }

  private async dispelFolder(path: string): Promise<void> {
    const cleanPath = normalizeVirtualPath(path)
    if (cleanPath === '/' || !await this.folderAt(cleanPath)) {
      throw new HTTPException(403, { message: `Only folders in ${POOL_NAME} can be removed from here.` })
    }
    await this.assertReadable(cleanPath)
    await deletePoolSubtreeData(this.env, cleanPath)
    await removePoolSubtree(this.env.DB, cleanPath)
  }

  private async folderAt(path: string): Promise<PoolFolderRecord | null> {
    return this.env.DB.prepare(
      `SELECT id, path, name, parent_path, created_by, access_mode, access_password_hash
         FROM pool_folders WHERE path = ?`
    ).bind(path).first<PoolFolderRecord>()
  }

  private async folderItem(folder: PoolFolderRecord, currentAccess?: FolderAccessState): Promise<FileItem | null> {
    const mode = folder.access_mode ?? 'public'
    const access = currentAccess
      ?? await evaluateFolderPolicies(this.env, 'pool', [{
        id: folder.id,
        path: folder.path,
        owner: folder.created_by,
        access_mode: mode,
        access_password_hash: folder.access_password_hash ?? null,
      }], this.request, this.actor.userId, this.actor.isMagician)
    if (access.hidden) return null
    return {
      id: encodePoolId(folder.path),
      name: folder.name,
      mimeType: POOL_FOLDER_MIME,
      size: null,
      modifiedTime: null,
      createdTime: null,
      thumbnailLink: null,
      isFolder: true,
      accessMode: mode,
      locked: access.locked,
    }
  }

  private fileItem(object: PoolObjectRecord): FileItem {
    return {
      id: encodeAggregateId(MANAGED_FILE_ID, object.id),
      name: object.name,
      mimeType: object.content_type,
      size: object.size,
      modifiedTime: null,
      createdTime: null,
      thumbnailLink: null,
      isFolder: false,
    }
  }

  private async fileOrThrow(fileId: string): Promise<PoolObjectRecord> {
    const { driveId, id } = decodeAggregateId(fileId)
    if (driveId !== MANAGED_FILE_ID) throw new HTTPException(404, { message: 'Pool file not found' })
    const object = await getPoolObject(this.env, id)
    if (!object || object.status !== 'ready') throw new HTTPException(404, { message: 'Pool file not found' })
    return object
  }

  private assertReadable(path: string): Promise<void> {
    return assertFolderReadable(this.env, 'pool', path, this.request, this.actor.userId, this.bypassAccess, this.actor.isMagician)
  }

  private requireMagician(action: string): void {
    if (!this.actor.isMagician || !this.actor.userId) {
      throw new HTTPException(403, { message: `${POOL_NAME} is shared storage: only a magician can ${action} here` })
    }
  }
}

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

/** Kept for legacy share IDs; new Cauldron files use managed object IDs. */
export async function encodePoolFileId(secret: string, driveId: string, fileId: string): Promise<string> {
  return encodeAggregateId(`${POOL_FILE_PREFIX}${driveId}`, `${fileId}|${await poolTag(secret, driveId, fileId)}`)
}

export async function verifyPoolFileId(secret: string, driveId: string, tagged: string): Promise<string | null> {
  const separator = tagged.lastIndexOf('|')
  if (separator < 1) return null
  const fileId = tagged.slice(0, separator)
  const tag = tagged.slice(separator + 1)
  const expected = await poolTag(secret, driveId, fileId)
  if (tag.length !== expected.length) return null
  let diff = 0
  for (let index = 0; index < expected.length; index += 1) diff |= tag.charCodeAt(index) ^ expected.charCodeAt(index)
  return diff === 0 ? fileId : null
}
