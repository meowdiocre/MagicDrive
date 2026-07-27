import { readFileSync, readdirSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { registerDriverFactory } from '../src/worker/drivers/registry'
import { decodeBase64UrlUtf8, encodeBase64UrlUtf8 } from '../src/worker/lib/base64'
import { normalizeVirtualPath } from '../src/worker/lib/path'
import type { StorageDriver, StorageUsage } from '../src/worker/drivers/contract'
import type { Bindings, DriveRecord, FileItem, ListResult } from '../src/worker/types'

export function migrate(db: DatabaseSync): void {
  const directory = new URL('../migrations/', import.meta.url)
  for (const file of readdirSync(directory).filter(file => file.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, directory), 'utf8'))
  }
}

/**
 * Enough of D1 and KV to drive the Worker end to end over the real schema. The
 * providers behind any drive stay unreachable, which is itself worth exercising.
 */
export function testBindings(db: DatabaseSync, vars: Partial<Bindings> = {}): Bindings {
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...args: unknown[]) => statement(sql, args),
    all: async () => ({ results: db.prepare(sql).all(...params as never[]) }),
    first: async () => db.prepare(sql).get(...params as never[]) ?? null,
    run: async () => ({ meta: { changes: db.prepare(sql).run(...params as never[]).changes } }),
  })

  const store = new Map<string, string>()
  return {
    DB: {
      prepare: (sql: string) => statement(sql),
      batch: async (statements: { run: () => Promise<unknown> }[]) => {
        db.exec('BEGIN')
        try {
          const results = []
          for (const prepared of statements) results.push(await prepared.run())
          db.exec('COMMIT')
          return results
        } catch (cause) {
          db.exec('ROLLBACK')
          throw cause
        }
      },
    },
    SESSIONS: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
    },
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'secret',
    DATA_ENCRYPTION_KEY: 'encryption-key',
    ...vars,
  } as unknown as Bindings
}

export function identify(token: string): RequestInit {
  return { headers: { Cookie: `vd_session=${token}` } }
}

interface MemoryEntry {
  bytes: Uint8Array
  contentType: string
}

/** One store per drive id, shared across driver instances like a real provider. */
export const memoryStores = new Map<string, Map<string, MemoryEntry>>()
export const memoryFailing = new Set<string>()
/** Provider writes fail while reads, health checks, and folder setup still work. */
export const memoryUploadFailing = new Set<string>()
/** Tests set a total per drive id; used bytes always come from the store. */
export const memoryQuota = new Map<string, number>()
/** Items per listing page, so tests can exercise the paginated paths. */
export const memoryPageSize = new Map<string, number>()

export function resetMemory(): void {
  memoryStores.clear()
  memoryFailing.clear()
  memoryUploadFailing.clear()
  memoryQuota.clear()
  memoryPageSize.clear()
}

function storeFor(driveId: string): Map<string, MemoryEntry> {
  let store = memoryStores.get(driveId)
  if (!store) {
    store = new Map()
    memoryStores.set(driveId, store)
  }
  return store
}

/** Keys mirror the S3 driver: files are plain keys, folders are trailing-slash markers. */
export class MemoryDriver implements StorageDriver {
  readonly capabilities = ['list', 'search', 'download', 'upload', 'mkdir', 'delete', 'rename'] as const

  constructor(private readonly drive: DriveRecord) {}

  private get store(): Map<string, MemoryEntry> {
    if (memoryFailing.has(this.drive.id)) throw new Error(`Storage unreachable: ${this.drive.id}`)
    return storeFor(this.drive.id)
  }

  private static prefix(path: string): string {
    const clean = normalizeVirtualPath(path)
    return clean === '/' ? '' : `${clean.slice(1)}/`
  }

  async list(path: string, pageToken?: string | null): Promise<ListResult> {
    const prefix = MemoryDriver.prefix(path)
    const items = new Map<string, FileItem>()
    for (const [key, entry] of this.store) {
      if (!key.startsWith(prefix) || key === prefix) continue
      const rest = key.slice(prefix.length)
      const segment = rest.split('/')[0]
      if (items.has(segment)) continue
      const isFolder = rest.includes('/')
      items.set(segment, {
        id: encodeBase64UrlUtf8(isFolder ? `${prefix}${segment}/` : key),
        name: segment,
        mimeType: isFolder ? 'httpd/unix-directory' : entry.contentType,
        size: isFolder ? null : entry.bytes.byteLength,
        modifiedTime: null, createdTime: null, thumbnailLink: null,
        isFolder,
      })
    }

    const all = [...items.values()]
    const size = memoryPageSize.get(this.drive.id)
    if (!size) return { path: normalizeVirtualPath(path), items: all, nextPageToken: null }
    const from = Number(pageToken) || 0
    const slice = all.slice(from, from + size)
    return {
      path: normalizeVirtualPath(path),
      items: slice,
      nextPageToken: from + size < all.length ? String(from + size) : null,
    }
  }

  async search(query: string): Promise<FileItem[]> {
    const wanted = query.toLowerCase()
    const results: FileItem[] = []
    for (const [key, entry] of this.store) {
      if (key.endsWith('/')) continue
      const name = key.split('/').pop() ?? key
      if (!name.toLowerCase().includes(wanted)) continue
      results.push({
        id: encodeBase64UrlUtf8(key), name, mimeType: entry.contentType,
        size: entry.bytes.byteLength, modifiedTime: null, createdTime: null,
        thumbnailLink: null, isFolder: false,
      })
    }
    return results
  }

  async download(fileId: string): Promise<Response> {
    const key = decodeBase64UrlUtf8(fileId)
    const entry = this.store.get(key)
    if (!entry) throw new Error(`Not found: ${key}`)
    return new Response(entry.bytes.slice(), { headers: { 'Content-Type': entry.contentType } })
  }

  async thumbnail(): Promise<Response> {
    return new Response('No thumbnail', { status: 404 })
  }

  async upload(path: string, filename: string, body: ReadableStream | ArrayBuffer, contentType: string): Promise<FileItem> {
    if (memoryUploadFailing.has(this.drive.id)) throw new Error(`Upload failed: ${this.drive.id}`)
    const bytes = body instanceof ArrayBuffer
      ? new Uint8Array(body)
      : new Uint8Array(await new Response(body).arrayBuffer())
    const key = `${MemoryDriver.prefix(path)}${filename}`
    this.store.set(key, { bytes, contentType })
    return {
      id: encodeBase64UrlUtf8(key), name: filename, mimeType: contentType,
      size: bytes.byteLength, modifiedTime: null, createdTime: null,
      thumbnailLink: null, isFolder: false,
    }
  }

  async mkdir(path: string, name: string): Promise<FileItem> {
    const key = `${MemoryDriver.prefix(path)}${name}/`
    this.store.set(key, { bytes: new Uint8Array(), contentType: 'httpd/unix-directory' })
    return {
      id: encodeBase64UrlUtf8(key), name, mimeType: 'httpd/unix-directory',
      size: null, modifiedTime: null, createdTime: null, thumbnailLink: null,
      isFolder: true,
    }
  }

  async remove(fileId: string): Promise<void> {
    const key = decodeBase64UrlUtf8(fileId)
    if (!key.endsWith('/')) {
      this.store.delete(key)
      return
    }
    for (const existing of [...this.store.keys()]) {
      if (existing === key || existing.startsWith(key)) this.store.delete(existing)
    }
  }

  async rename(fileId: string, newName: string): Promise<Pick<FileItem, 'id' | 'name'>> {
    const key = decodeBase64UrlUtf8(fileId)
    const entry = this.store.get(key)
    if (!entry) throw new Error(`Not found: ${key}`)
    const parent = key.includes('/') ? key.slice(0, key.lastIndexOf('/') + 1) : ''
    const newKey = `${parent}${newName}`
    this.store.delete(key)
    this.store.set(newKey, entry)
    return { id: encodeBase64UrlUtf8(newKey), name: newName }
  }

  async getUsage(): Promise<StorageUsage> {
    let used = 0
    for (const entry of this.store.values()) used += entry.bytes.byteLength
    const total = memoryQuota.get(this.drive.id) ?? null
    return {
      usedBytes: used,
      totalBytes: total,
      freeBytes: total !== null ? Math.max(0, total - used) : null,
    }
  }
}

/**
 * Routes drives stored under a base provider id to MemoryDriver for this test
 * process. The drives schema constrains provider ids, so tests reuse a real one.
 */
export function registerMemoryProvider(id = 's3'): void {
  registerDriverFactory(id, (_env, drive) => new MemoryDriver(drive))
}

export async function payload<T>(response: Response): Promise<T> {
  return (await response.json() as { data: T; error?: string }).data
}

export async function errorOf(response: Response): Promise<string> {
  return (await response.json() as { error: string }).error
}
