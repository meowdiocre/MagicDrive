import { decryptSecret } from '../lib/crypto'
import { providerFileResponse } from '../lib/file-response'
import { escapeDriveQuery, normalizeVirtualPath, pathParts } from '../lib/path'
import type { Bindings, DriveRecord, FileItem, ListResult } from '../types'
import type { Capability, StorageDriver, StorageUsage } from './contract'

const GOOGLE_FOLDER = 'application/vnd.google-apps.folder'

interface GoogleFile {
  id: string
  name: string
  mimeType: string
  size?: string
  modifiedTime?: string
  createdTime?: string
  thumbnailLink?: string
  shortcutDetails?: {
    targetId?: string
    targetMimeType?: string
  }
}

interface GoogleListResponse {
  files?: GoogleFile[]
  nextPageToken?: string
}

interface GoogleTokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

interface GoogleMetadata extends GoogleFile {
  webContentLink?: string
  ownedByMe?: boolean
}

const READ_ONLY: readonly Capability[] = ['list', 'search', 'download', 'thumbnail']
const FULL: readonly Capability[] = [...READ_ONLY, 'upload', 'mkdir', 'delete', 'rename']

export function grantsWrite(scope: string): boolean {
  return scope.split(/\s+/).some(entry =>
    entry === 'https://www.googleapis.com/auth/drive' ||
    entry === 'https://www.googleapis.com/auth/drive.file'
  )
}

export class GoogleDriveDriver implements StorageDriver {
  readonly capabilities: readonly Capability[]

  constructor(
    private readonly env: Bindings,
    private readonly drive: DriveRecord
  ) {
    this.capabilities = grantsWrite(drive.granted_scope) ? FULL : READ_ONLY
  }

  private async accessToken(): Promise<string> {
    const cacheKey = `google:access:${this.drive.id}`
    const cached = await this.env.SESSIONS.get(cacheKey)
    if (cached) return cached

    if (!this.drive.refresh_token_enc) throw new Error('Drive has no refresh token')
    const refreshToken = await decryptSecret(this.env.DATA_ENCRYPTION_KEY, this.drive.refresh_token_enc)
    const body = new URLSearchParams({
      client_id: this.env.GOOGLE_CLIENT_ID,
      client_secret: this.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    })
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    const data = (await response.json()) as GoogleTokenResponse
    if (!response.ok || !data.access_token) {
      throw new Error(data.error_description || data.error || 'Google token refresh failed')
    }
    await this.env.SESSIONS.put(cacheKey, data.access_token, {
      expirationTtl: Math.max(60, (data.expires_in ?? 3600) - 120),
    })
    return data.access_token
  }

  private async googleFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${await this.accessToken()}`)
    const response = await fetch(`https://www.googleapis.com${path}`, { ...init, headers })
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
      throw new Error(payload?.error?.message || `Google Drive returned ${response.status}`)
    }
    return response.json() as Promise<T>
  }

  private async findChild(parentId: string, name: string): Promise<GoogleFile | null> {
    const params = new URLSearchParams({
      q: `'${escapeDriveQuery(parentId)}' in parents and name = '${escapeDriveQuery(name)}' and trashed = false`,
      fields: 'files(id,name,mimeType,shortcutDetails(targetId,targetMimeType))',
      pageSize: '2',
      spaces: 'drive',
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
    })
    const data = await this.googleFetch<GoogleListResponse>(`/drive/v3/files?${params}`)
    return data.files?.[0] ?? null
  }

  private async resolveFolder(path: string): Promise<string> {
    let currentId = this.drive.root_id || 'root'
    for (const segment of pathParts(path)) {
      const item = await this.findChild(currentId, segment)
      if (!item) throw new Error(`Folder not found: ${segment}`)
      const targetMimeType = item.shortcutDetails?.targetMimeType ?? item.mimeType
      const targetId = item.shortcutDetails?.targetId ?? item.id
      if (targetMimeType !== GOOGLE_FOLDER) throw new Error(`Not a folder: ${segment}`)
      currentId = targetId
    }
    return currentId
  }

  async list(path: string, pageToken?: string | null): Promise<ListResult> {
    if (pageToken && pageToken.length > 2048) throw new Error('Invalid page token')
    const cleanPath = normalizeVirtualPath(path)
    const folderId = await this.resolveFolder(cleanPath)
    const params = new URLSearchParams({
      q: `'${escapeDriveQuery(folderId)}' in parents and trashed = false and 'me' in owners`,
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,createdTime,thumbnailLink,shortcutDetails(targetId,targetMimeType))',
      pageSize: '200',
      spaces: 'drive',
      orderBy: 'folder,name_natural',
      includeItemsFromAllDrives: 'false',
      supportsAllDrives: 'true',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const data = await this.googleFetch<GoogleListResponse>(`/drive/v3/files?${params}`)
    const items = (data.files ?? []).map(item => this.toFileItem(item))
    return { path: cleanPath, items, nextPageToken: data.nextPageToken ?? null }
  }

  async getUsage(): Promise<StorageUsage> {
    const data = await this.googleFetch<{ storageQuota?: { limit?: string; usage?: string } }>(
      '/drive/v3/about?fields=storageQuota'
    )
    const used = data.storageQuota?.usage ? Number(data.storageQuota.usage) : null
    // No limit means an unlimited plan, which has no meaningful total or free.
    const total = data.storageQuota?.limit ? Number(data.storageQuota.limit) : null
    return {
      usedBytes: used,
      totalBytes: total,
      freeBytes: total !== null && used !== null ? Math.max(0, total - used) : null,
    }
  }

  async search(query: string): Promise<FileItem[]> {
    const trimmed = query.trim()
    if (trimmed.length < 2 || trimmed.length > 100) throw new Error('Search must be 2–100 characters')
    // "'me' in owners" keeps search inside the connected account's own files.
    // Without it, anything merely shared WITH this account would surface, which
    // would publish third parties' documents that were never contributed here.
    const params = new URLSearchParams({
      q: `name contains '${escapeDriveQuery(trimmed)}' and trashed = false and 'me' in owners`,
      fields: 'files(id,name,mimeType,size,modifiedTime,createdTime,thumbnailLink,shortcutDetails(targetId,targetMimeType))',
      pageSize: '100',
      spaces: 'drive',
      orderBy: 'modifiedTime desc',
      includeItemsFromAllDrives: 'false',
      supportsAllDrives: 'true',
    })
    const data = await this.googleFetch<GoogleListResponse>(`/drive/v3/files?${params}`)
    return (data.files ?? []).map(item => this.toFileItem(item))
  }

  async metadata(fileId: string): Promise<GoogleMetadata> {
    if (!/^[A-Za-z0-9_-]{5,200}$/.test(fileId)) throw new Error('Invalid file ID')
    const params = new URLSearchParams({
      fields: 'id,name,mimeType,size,modifiedTime,ownedByMe',
      supportsAllDrives: 'true',
    })
    const file = await this.googleFetch<GoogleMetadata>(`/drive/v3/files/${encodeURIComponent(fileId)}?${params}`)
    // A file id alone must not grant access to something this account merely
    // has visibility of; only files it owns are part of the contributed drive.
    if (file.ownedByMe !== true) throw new Error('File not found')
    return file
  }

  async thumbnail(fileId: string): Promise<Response> {
    const file = await this.metadata(fileId)
    if (!file.thumbnailLink) return new Response('No thumbnail', { status: 404 })
    const upstream = await fetch(file.thumbnailLink, {
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
    })
    if (!upstream.ok) return new Response('Thumbnail unavailable', { status: 502 })
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'image/jpeg',
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }

  async download(fileId: string, request: Request, disposition: 'attachment' | 'inline' = 'attachment'): Promise<Response> {
    const file = await this.metadata(fileId)
    if (file.mimeType === GOOGLE_FOLDER) throw new Error('Folders cannot be downloaded directly')

    const exportTarget = googleExport(file.mimeType)
    const target = exportTarget
      ? `/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportTarget.mimeType)}`
      : `/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&acknowledgeAbuse=true&supportsAllDrives=true`

    const headers = new Headers({ Authorization: `Bearer ${await this.accessToken()}` })
    const range = request.headers.get('Range')
    if (range && !exportTarget) headers.set('Range', range)
    const upstream = await fetch(`https://www.googleapis.com${target}`, { headers })
    if (!upstream.ok && upstream.status !== 206) {
      throw new Error(`Google download returned ${upstream.status}`)
    }

    const filename = exportTarget && !file.name.toLowerCase().endsWith(exportTarget.extension)
      ? `${file.name}${exportTarget.extension}`
      : file.name
    return providerFileResponse(upstream, filename, disposition)
  }
  async upload(path: string, filename: string, body: ReadableStream | ArrayBuffer, contentType: string, _size: number): Promise<FileItem> {
    const parentId = await this.resolveFolder(path)
    const metadata = JSON.stringify({ name: filename, parents: [parentId] })
    const boundary = `magicdrive-${crypto.randomUUID()}`
    const encoder = new TextEncoder()
    const safeContentType = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(contentType)
      ? contentType
      : 'application/octet-stream'
    const head = encoder.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${safeContentType}\r\n\r\n`
    )
    const tail = encoder.encode(`\r\n--${boundary}--`)

    const response = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size,modifiedTime,createdTime,thumbnailLink',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        // Keep the provider payload streaming. Buffering the source plus a second
        // multipart copy can exceed a Worker's memory limit near the route cap.
        body: multipartRelatedBody(head, body, tail),
      }
    )
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
      throw new Error(detail?.error?.message || `Google upload returned ${response.status}`)
    }
    return this.toFileItem((await response.json()) as GoogleFile)
  }

  async mkdir(path: string, name: string): Promise<FileItem> {
    const parentId = await this.resolveFolder(path)
    const created = await this.googleFetch<GoogleFile>(
      '/drive/v3/files?supportsAllDrives=true&fields=id,name,mimeType,modifiedTime,createdTime',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: GOOGLE_FOLDER, parents: [parentId] }),
      }
    )
    return this.toFileItem(created)
  }

  async remove(fileId: string): Promise<void> {
    await this.metadata(fileId)
    await this.googleFetch<GoogleFile>(`/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    })
  }

  async rename(fileId: string, newName: string, _path?: string): Promise<FileItem> {
    await this.metadata(fileId)
    const updated = await this.googleFetch<GoogleFile>(
      `/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,name,mimeType,size,modifiedTime,createdTime,thumbnailLink`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      }
    )
    return this.toFileItem(updated)
  }

  private toFileItem(item: GoogleFile): FileItem {
    return {
      id: item.shortcutDetails?.targetId ?? item.id,
      name: item.name,
      mimeType: item.shortcutDetails?.targetMimeType ?? item.mimeType,
      size: item.size ? Number(item.size) : null,
      modifiedTime: item.modifiedTime ?? null,
      createdTime: item.createdTime ?? null,
      thumbnailLink: item.thumbnailLink ?? null,
      isFolder: (item.shortcutDetails?.targetMimeType ?? item.mimeType) === GOOGLE_FOLDER,
    }
  }
}

export function multipartRelatedBody(
  head: Uint8Array,
  body: ReadableStream | ArrayBuffer,
  tail: Uint8Array
): ReadableStream<Uint8Array> {
  const file = body instanceof ArrayBuffer ? byteStream(new Uint8Array(body)) : body
  const readers = [byteStream(head), file, byteStream(tail)].map(stream => stream.getReader())
  let current = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (current < readers.length) {
        const chunk = await readers[current].read()
        if (chunk.done) {
          current += 1
          continue
        }
        controller.enqueue(chunk.value)
        return
      }
      controller.close()
    },
    async cancel(reason) {
      await Promise.all(readers.map(reader => reader.cancel(reason).catch(() => {})))
    },
  })
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function googleExport(mimeType: string): { mimeType: string; extension: string } | null {
  const formats: Record<string, { mimeType: string; extension: string }> = {
    'application/vnd.google-apps.document': { mimeType: 'application/pdf', extension: '.pdf' },
    'application/vnd.google-apps.spreadsheet': {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: '.xlsx',
    },
    'application/vnd.google-apps.presentation': {
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      extension: '.pptx',
    },
    'application/vnd.google-apps.drawing': { mimeType: 'application/pdf', extension: '.pdf' },
  }
  return formats[mimeType] ?? null
}
