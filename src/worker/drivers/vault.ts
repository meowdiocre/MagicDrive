import { HTTPException } from 'hono/http-exception'
import { createDriver } from './registry'
import type { Capability, StorageDriver } from './contract'
import { providerFileResponse } from '../lib/file-response'
import { escapeLike, joinVirtualPath, normalizeVirtualPath } from '../lib/path'
import { sha256Hex } from '../lib/crypto'
import { decryptSegment, generateWrappedKey, unwrapKey } from '../lib/vault-crypto'
import {
  assertParentWritable, assertPathFree, childCount, deleteObjectData, getObject, getObjectByPath,
  insertObject, listChildren, listSegments, loadDriveById, searchObjects, segmentSize, storeSegment,
} from '../lib/vault'
import type { Bindings, FileItem, ListResult, VaultObjectRecord, VaultSegmentRecord } from '../types'

export const VAULT_FOLDER_MIME = 'application/vnd.magicdrive.vault-folder'

/**
 * A virtual drive whose tree lives in D1 and whose bytes live as encrypted
 * segments striped across the object owner's own connected vaults. Reads are
 * public like everything else; every mutation checks the object's owner.
 */
export class VaultDriver implements StorageDriver {
  readonly capabilities: readonly Capability[] = ['list', 'search', 'download', 'upload', 'mkdir', 'delete', 'rename']

  constructor(
    private readonly env: Bindings,
    private readonly userId: string | null
  ) {}

  async list(path: string): Promise<ListResult> {
    const cleanPath = normalizeVirtualPath(path)
    if (cleanPath !== '/') {
      const folder = await getObjectByPath(this.env, cleanPath)
      if (!folder || folder.kind !== 'folder') throw new HTTPException(404, { message: 'Folder not found' })
    }
    const children = await listChildren(this.env, cleanPath)
    return { path: cleanPath, items: children.map(child => this.toItem(child)), nextPageToken: null }
  }

  async search(query: string): Promise<FileItem[]> {
    const trimmed = query.trim()
    if (trimmed.length < 2) return []
    return (await searchObjects(this.env, trimmed)).map(object => this.toItem(object))
  }

  private toItem(object: VaultObjectRecord): FileItem {
    return { ...toFileItem(object), readOnly: object.owner !== this.userId }
  }

  async download(fileId: string, request: Request, disposition: 'attachment' | 'inline' = 'attachment'): Promise<Response> {
    const object = await this.fileOrThrow(fileId)
    const segments = await listSegments(this.env, object.id)
    const total = object.size ?? 0
    if (!object.key_enc || segments.length === 0 || total === 0) {
      throw new HTTPException(500, { message: 'File has no stored content' })
    }
    const key = await unwrapKey(this.env.DATA_ENCRYPTION_KEY, object.key_enc)
    const perSegment = object.segment_size ?? segments[0].size

    const range = parseRange(request.headers.get('Range'), total)
    const [start, end] = range ?? [0, total - 1]
    const body = this.segmentStream(object, segments, key, perSegment, start, end)

    const headers = new Headers({
      'Content-Type': object.content_type ?? 'application/octet-stream',
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    })
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${total}`)
    return providerFileResponse(
      new Response(body, { status: range ? 206 : 200, headers }),
      object.name,
      disposition
    )
  }

  /** Pulls one segment at a time: decrypt whole, slice to the requested window. */
  private segmentStream(
    object: VaultObjectRecord,
    segments: VaultSegmentRecord[],
    key: CryptoKey,
    perSegment: number,
    start: number,
    end: number
  ): ReadableStream<Uint8Array> {
    const env = this.env
    const byIndex = new Map(segments.map(segment => [segment.idx, segment]))
    let index = Math.floor(start / perSegment)
    const lastIndex = Math.floor(end / perSegment)

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
          const cipher = await fetchSegment(env, segment)
          if (await sha256Hex(cipher) !== segment.sha256) {
            throw new Error(`Segment ${index} failed its integrity check`)
          }
          const plaintext = await decryptSegment(key, object.id, index, cipher)
          const offset = index * perSegment
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

  /**
   * Single-segment files only: anything larger goes through the chunked upload
   * session, where each piece arrives as its own request.
   */
  async upload(path: string, filename: string, body: ReadableStream | ArrayBuffer, contentType: string, size: number): Promise<FileItem> {
    const owner = this.requireUser('upload')
    const perSegment = segmentSize(this.env)
    if (size > perSegment) {
      throw new HTTPException(413, { message: 'File is larger than one piece; use the chunked upload' })
    }
    const parentPath = normalizeVirtualPath(path)
    await assertParentWritable(this.env, parentPath, owner)
    const target = joinVirtualPath(parentPath, filename)
    await assertPathFree(this.env, target)

    const bytes = body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer()
    if (bytes.byteLength === 0) throw new HTTPException(400, { message: 'Empty upload' })
    const object = await insertObject(this.env, {
      parentPath, name: filename, path: target, kind: 'file', owner,
      size: bytes.byteLength, contentType,
      keyEnc: await generateWrappedKey(this.env.DATA_ENCRYPTION_KEY),
      segmentSize: perSegment, uploading: true,
    })
    try {
      await storeSegment(this.env, object, 0, bytes)
    } catch (cause) {
      await deleteObjectData(this.env, object)
      throw cause
    }
    await this.env.DB.prepare(
      "UPDATE vault_objects SET status = 'ready', expires_at = NULL, updated_at = ? WHERE id = ?"
    ).bind(new Date().toISOString(), object.id).run()
    return toFileItem({ ...object, status: 'ready' })
  }

  async mkdir(path: string, name: string): Promise<FileItem> {
    const owner = this.requireUser('create folders')
    const parentPath = normalizeVirtualPath(path)
    await assertParentWritable(this.env, parentPath, owner)
    const target = joinVirtualPath(parentPath, name)
    await assertPathFree(this.env, target)
    const object = await insertObject(this.env, { parentPath, name, path: target, kind: 'folder', owner })
    return toFileItem(object)
  }

  async remove(fileId: string): Promise<void> {
    const object = await this.ownedOrThrow(fileId, 'delete')
    // Counts uploads in flight: a folder emptied of only its visible children
    // would strand whichever upload commits next under a path that is gone.
    if (object.kind === 'folder' && await childCount(this.env, object.path) > 0) {
      throw new HTTPException(409, { message: 'Empty the folder first; vault folders do not delete their contents' })
    }
    await deleteObjectData(this.env, object)
  }

  async rename(fileId: string, newName: string, _path?: string): Promise<Pick<FileItem, 'id' | 'name'>> {
    const object = await this.ownedOrThrow(fileId, 'rename')
    const target = joinVirtualPath(object.parent_path, newName)
    if (target !== object.path) await assertPathFree(this.env, target)
    const now = new Date().toISOString()
    const statements = [this.env.DB.prepare(
      'UPDATE vault_objects SET name = ?, path = ?, updated_at = ? WHERE id = ?'
    ).bind(newName, target, now, object.id)]
    if (object.kind === 'folder') {
      // Children key their location by path, so the subtree moves with the folder.
      const prefix = `${escapeLike(object.path)}/%`
      statements.push(this.env.DB.prepare(
        `UPDATE vault_objects SET
           path = ? || substr(path, ?),
           parent_path = ? || substr(parent_path, ?),
           updated_at = ?
         WHERE path LIKE ? ESCAPE '\\'`
      ).bind(target, object.path.length + 1, target, object.path.length + 1, now, prefix))
    }
    await this.env.DB.batch(statements)
    return { id: object.id, name: newName }
  }

  private requireUser(action: string): string {
    if (!this.userId) throw new HTTPException(401, { message: `Sign in to ${action} in MagicVault` })
    return this.userId
  }

  private async fileOrThrow(fileId: string): Promise<VaultObjectRecord> {
    const object = await getObject(this.env, fileId)
    if (!object || object.status !== 'ready') throw new HTTPException(404, { message: 'File not found' })
    if (object.kind !== 'file') throw new HTTPException(400, { message: 'Folders cannot be downloaded' })
    return object
  }

  private async ownedOrThrow(fileId: string, action: string): Promise<VaultObjectRecord> {
    this.requireUser(action)
    const object = await getObject(this.env, fileId)
    if (!object) throw new HTTPException(404, { message: 'Not found' })
    if (object.owner !== this.userId) {
      throw new HTTPException(403, { message: `Only the owner can ${action} this` })
    }
    return object
  }
}

function toFileItem(object: VaultObjectRecord): FileItem {
  return {
    id: object.id,
    name: object.name,
    mimeType: object.kind === 'folder' ? VAULT_FOLDER_MIME : (object.content_type ?? 'application/octet-stream'),
    size: object.size,
    modifiedTime: null,
    createdTime: null,
    thumbnailLink: null,
    isFolder: object.kind === 'folder',
  }
}

async function fetchSegment(env: Bindings, segment: VaultSegmentRecord): Promise<ArrayBuffer> {
  const drive = await loadDriveById(env, segment.drive_id)
  if (!drive) throw new Error('The vault holding this piece is no longer connected')
  const response = await createDriver(env, drive).download(segment.provider_ref, new Request('https://vault.internal/'))
  if (!response.ok) throw new Error(`Vault read returned ${response.status}`)
  return response.arrayBuffer()
}

/** Single ranges only; anything else falls back to the full body. */
export function parseRange(header: string | null, total: number): [number, number] | null {
  if (!header || total <= 0) return null
  const match = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!match || (match[1] === '' && match[2] === '')) return null
  if (match[1] === '') {
    const suffix = Math.min(Number(match[2]), total)
    return suffix > 0 ? [total - suffix, total - 1] : null
  }
  const start = Number(match[1])
  if (start >= total) throw new HTTPException(416, { message: 'Range not satisfiable' })
  const end = match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1)
  return start <= end ? [start, end] : null
}
