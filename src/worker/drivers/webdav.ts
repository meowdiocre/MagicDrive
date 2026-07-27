import { HTTPException } from 'hono/http-exception'
import { decryptSecret } from '../lib/crypto'
import { decodeBase64UrlUtf8, encodeBase64UrlUtf8, encodeBase64Utf8 } from '../lib/base64'
import { providerFileResponse } from '../lib/file-response'
import { fixedLength } from '../lib/http'
import { normalizeVirtualPath } from '../lib/path'
import type { Bindings, DriveRecord, FileItem, ListResult, WebDavConfig } from '../types'
import type { StorageDriver, StorageUsage } from './contract'

// WebDAV uses paths as IDs (base64url-encoded to keep them route-safe).
function encodeId(path: string): string {
  return encodeBase64UrlUtf8(path)
}

export function decodeWebDavId(id: string): string {
  try {
    const path = decodeBase64UrlUtf8(id)
    const parts = path.replaceAll('\\', '/').split('/')
    if (!path.startsWith('/') || path.includes('\0') || parts.some(part => part === '.' || part === '..')) {
      throw new Error('Invalid path')
    }
    return path
  } catch {
    throw new HTTPException(400, { message: 'Invalid file ID' })
  }
}

export function decodeXmlEntities(value: string): string {
  const codePoint = (match: string, digits: string, radix: number) => {
    const value = Number.parseInt(digits, radix)
    return Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
      ? String.fromCodePoint(value)
      : match
  }
  return value
    .replace(/&#x([0-9a-f]+);/gi, (match, digits: string) => codePoint(match, digits, 16))
    .replace(/&#(\d+);/g, (match, digits: string) => codePoint(match, digits, 10))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

/** A negative value is RFC-speak for "no quota configured". */
function quotaValue(xml: string, property: string): number | null {
  const match = xml.match(new RegExp(`<[^>]*:?${property}[^>]*>(-?\\d+)</[^>]*:?${property}>`, 'i'))
  if (!match) return null
  const value = Number(match[1])
  return value >= 0 ? value : null
}

interface DavEntry {
  href: string
  displayName: string
  isCollection: boolean
  contentLength: number | null
  lastModified: string | null
  contentType: string | null
}

export class WebDavDriver implements StorageDriver {
  readonly capabilities = ['list', 'download', 'upload', 'mkdir', 'delete', 'rename'] as const
  private config: WebDavConfig | null = null

  constructor(
    private readonly env: Bindings,
    private readonly drive: DriveRecord
  ) {}

  private async getConfig(): Promise<WebDavConfig> {
    if (this.config) return this.config
    if (!this.drive.config_enc) throw new Error('WebDAV drive has no configuration')
    this.config = JSON.parse(await decryptSecret(this.env.DATA_ENCRYPTION_KEY, this.drive.config_enc)) as WebDavConfig
    if (new URL(this.config.url).protocol !== 'https:') throw new Error('WebDAV URL must use HTTPS')
    return this.config
  }

  private async davFetch(path: string, init?: RequestInit): Promise<Response> {
    const config = await this.getConfig()
    const base = config.url.replace(/\/+$/, '')
    const url = `${base}${path.split('/').map(encodeURIComponent).join('/')}`
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Basic ${encodeBase64Utf8(`${config.username}:${config.password}`)}`)
    return fetch(url, { ...init, headers })
  }

  private parseMultistatus(xml: string, requestPath: string): DavEntry[] {
    const entries: DavEntry[] = []
    const responses = xml.match(/<[^>]*:?response[ >][\s\S]*?<\/[^>]*:?response>/gi) ?? []
    for (const block of responses) {
      const hrefText = decodeXmlEntities(block.match(/<[^>]*:?href[^>]*>([\s\S]*?)<\/[^>]*:?href>/i)?.[1]?.trim() ?? '')
      let href: string
      try {
        href = decodeURIComponent(hrefText)
      } catch {
        href = hrefText
      }
      if (!href) continue
      const isCollection = /<[^>]*:?collection\s*\/?>/i.test(block)
      const displayName = decodeXmlEntities(block.match(/<[^>]*:?displayname[^>]*>([\s\S]*?)<\/[^>]*:?displayname>/i)?.[1]?.trim() ?? '')
        || href.replace(/\/+$/, '').split('/').pop() || ''
      const lengthText = block.match(/<[^>]*:?getcontentlength[^>]*>(\d+)<\/[^>]*:?getcontentlength>/i)?.[1]
      const lastModified = block.match(/<[^>]*:?getlastmodified[^>]*>([\s\S]*?)<\/[^>]*:?getlastmodified>/i)?.[1]?.trim() ?? null
      const contentType = block.match(/<[^>]*:?getcontenttype[^>]*>([\s\S]*?)<\/[^>]*:?getcontenttype>/i)?.[1]?.trim() ?? null
      const hrefPath = href.replace(/^https?:\/\/[^/]+/, '').replace(/\/+$/, '') || '/'
      const requestNorm = requestPath.replace(/\/+$/, '') || '/'
      if (hrefPath.endsWith(requestNorm) && (hrefPath === requestNorm || hrefPath.split('/').length <= requestNorm.split('/').length)) continue
      entries.push({
        href: hrefPath,
        displayName,
        isCollection,
        contentLength: lengthText ? Number(lengthText) : null,
        lastModified: lastModified ? new Date(lastModified).toISOString() : null,
        contentType,
      })
    }
    return entries
  }

  /** Decoded, because hrefs are decoded before comparison and a space must match %20. */
  private basePath(): Promise<string> {
    return this.getConfig().then(config => {
      const raw = new URL(config.url).pathname
      // A literal '%' in the path is not valid percent-encoding; keep it as-is
      // rather than throwing URIError and taking the whole listing down.
      let decoded: string
      try {
        decoded = decodeURIComponent(raw)
      } catch {
        decoded = raw
      }
      return decoded.replace(/\/+$/, '')
    })
  }

  async list(path: string): Promise<ListResult> {
    const cleanPath = normalizeVirtualPath(path)
    const response = await this.davFetch(cleanPath === '/' ? '/' : cleanPath, {
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><propfind xmlns="DAV:"><allprop/></propfind>',
    })
    if (!response.ok && response.status !== 207) throw new Error(`WebDAV returned ${response.status}`)
    const body = await response.text()
    // 207 with a multistatus body is what a WebDAV server answers. Anything else
    // is some other HTTPS service, and treating it as an empty folder would let
    // it pass the connection test that runs before a drive is saved.
    if (response.status !== 207 && !/<[^>]*:?multistatus[\s>]/i.test(body)) {
      throw new Error('That URL did not answer as a WebDAV server')
    }
    const base = await this.basePath()
    const entries = this.parseMultistatus(body, `${base}${cleanPath === '/' ? '' : cleanPath}`)
    const items = entries.map<FileItem>(entry => {
      const relative = base && entry.href.startsWith(base) ? entry.href.slice(base.length) : entry.href
      return {
        id: encodeId(relative || '/'),
        name: entry.displayName,
        mimeType: entry.isCollection ? 'httpd/unix-directory' : (entry.contentType ?? 'application/octet-stream'),
        size: entry.contentLength,
        modifiedTime: entry.lastModified,
        createdTime: null,
        thumbnailLink: null,
        isFolder: entry.isCollection,
      }
    }).sort((left, right) => Number(right.isFolder) - Number(left.isFolder) || left.name.localeCompare(right.name))
    return { path: cleanPath, items, nextPageToken: null }
  }

  async search(): Promise<FileItem[]> {
    throw new Error('This provider does not support: search')
  }

  /** RFC 4331 quota properties; servers that skip them report all nulls. */
  async getUsage(): Promise<StorageUsage> {
    const response = await this.davFetch('/', {
      method: 'PROPFIND',
      headers: { Depth: '0', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><quota-available-bytes/><quota-used-bytes/></prop></propfind>',
    })
    if (!response.ok && response.status !== 207) throw new Error(`WebDAV returned ${response.status}`)
    const xml = await response.text()
    const available = quotaValue(xml, 'quota-available-bytes')
    const used = quotaValue(xml, 'quota-used-bytes')
    return {
      usedBytes: used,
      totalBytes: used !== null && available !== null ? used + available : null,
      freeBytes: available,
    }
  }

  async download(fileId: string, request: Request, disposition: 'attachment' | 'inline' = 'attachment'): Promise<Response> {
    const path = decodeWebDavId(fileId)
    const headers: HeadersInit = {}
    const range = request.headers.get('Range')
    if (range) (headers as Record<string, string>).Range = range
    const upstream = await this.davFetch(path, { headers })
    if (!upstream.ok && upstream.status !== 206) throw new Error(`WebDAV download returned ${upstream.status}`)
    const filename = path.split('/').pop() || 'download'
    return providerFileResponse(upstream, filename, disposition)
  }

  async thumbnail(): Promise<Response> {
    return new Response('No thumbnail', { status: 404 })
  }

  async upload(path: string, filename: string, body: ReadableStream | ArrayBuffer, contentType: string, size: number): Promise<FileItem> {
    const cleanPath = normalizeVirtualPath(path)
    const target = `${cleanPath === '/' ? '' : cleanPath}/${filename}`
    // Several WebDAV servers reject a chunked PUT, and a hand-set Content-Length
    // does not survive a stream body, so the runtime is made to emit a real one.
    const init: RequestInit = {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: body instanceof ReadableStream ? fixedLength(body, size) : body,
    }
    if (body instanceof ReadableStream) (init as RequestInit & { duplex: string }).duplex = 'half'
    const response = await this.davFetch(target, init)
    if (!response.ok) throw new Error(`WebDAV upload returned ${response.status}`)
    return {
      id: encodeId(target),
      name: filename,
      mimeType: contentType,
      size,
      modifiedTime: new Date().toISOString(),
      createdTime: null,
      thumbnailLink: null,
      isFolder: false,
    }
  }

  async mkdir(path: string, name: string): Promise<FileItem> {
    const cleanPath = normalizeVirtualPath(path)
    const target = `${cleanPath === '/' ? '' : cleanPath}/${name}`
    const response = await this.davFetch(target, { method: 'MKCOL' })
    if (!response.ok) throw new Error(`WebDAV mkdir returned ${response.status}`)
    return {
      id: encodeId(target),
      name,
      mimeType: 'httpd/unix-directory',
      size: null,
      modifiedTime: new Date().toISOString(),
      createdTime: null,
      thumbnailLink: null,
      isFolder: true,
    }
  }

  async remove(fileId: string): Promise<void> {
    const path = decodeWebDavId(fileId)
    const response = await this.davFetch(path, { method: 'DELETE' })
    if (!response.ok && response.status !== 204) throw new Error(`WebDAV delete returned ${response.status}`)
  }

  async rename(fileId: string, newName: string, _path?: string): Promise<Pick<FileItem, 'id' | 'name'>> {
    const path = decodeWebDavId(fileId)
    const parent = path.slice(0, path.lastIndexOf('/'))
    const target = `${parent}/${newName}`
    const config = await this.getConfig()
    const base = config.url.replace(/\/+$/, '')
    const response = await this.davFetch(path, {
      method: 'MOVE',
      headers: { Destination: `${base}${target.split('/').map(encodeURIComponent).join('/')}`, Overwrite: 'F' },
    })
    if (!response.ok) throw new Error(`WebDAV rename returned ${response.status}`)
    return { id: encodeId(target), name: newName }
  }
}
