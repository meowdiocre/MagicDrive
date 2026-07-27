import { HTTPException } from 'hono/http-exception'
import { decryptSecret, hmacSha256, sha256Hex, toHex } from '../lib/crypto'
import { fixedLength } from '../lib/http'
import { decodeBase64UrlUtf8, encodeBase64UrlUtf8 } from '../lib/base64'
import { providerFileResponse } from '../lib/file-response'
import { normalizeVirtualPath } from '../lib/path'
import type { Bindings, DriveRecord, FileItem, ListResult, S3Config } from '../types'
import type { StorageDriver } from './contract'

// S3 object keys are used as IDs (base64url-encoded).
function encodeId(key: string): string {
  return encodeBase64UrlUtf8(key)
}

export function decodeS3Id(id: string): string {
  let key: string
  try {
    key = decodeBase64UrlUtf8(id)
  } catch {
    throw new HTTPException(400, { message: 'Invalid file ID' })
  }
  // fetch() normalizes dot segments out of the URL while the signature was
  // computed over the un-normalized path, so such a key can never be reached.
  if (key.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new HTTPException(400, { message: 'This object key cannot be addressed' })
  }
  return key
}

// S3 returns keys inside XML, so "a&b.txt" arrives as "a&amp;b.txt".
export function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

export function awsUriEncode(value: string, encodeSlash: boolean): string {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, char =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return encodeSlash ? encoded : encoded.replaceAll('%2F', '/')
}

export class S3Driver implements StorageDriver {
  readonly capabilities = ['list', 'download', 'upload', 'mkdir', 'delete', 'rename'] as const
  private config: S3Config | null = null

  constructor(
    private readonly env: Bindings,
    private readonly drive: DriveRecord
  ) {}

  private async getConfig(): Promise<S3Config> {
    if (this.config) return this.config
    if (!this.drive.config_enc) throw new Error('S3 drive has no configuration')
    this.config = JSON.parse(await decryptSecret(this.env.DATA_ENCRYPTION_KEY, this.drive.config_enc)) as S3Config
    if (new URL(this.config.endpoint).protocol !== 'https:') throw new Error('S3 endpoint must use HTTPS')
    return this.config
  }

  private async signedFetch(method: string, key: string, query: Record<string, string>, body?: ArrayBuffer | ReadableStream, extraHeaders?: Record<string, string>): Promise<Response> {
    const config = await this.getConfig()
    const endpoint = new URL(config.endpoint)
    const host = endpoint.host
    const endpointPath = endpoint.pathname
      .replace(/\/+$/, '')
      .split('/')
      .map(segment => awsUriEncode(decodeURIComponent(segment), true))
      .join('/')
    const canonicalUri = `${endpointPath}/${awsUriEncode(config.bucket, true)}${key ? `/${awsUriEncode(key, false)}` : ''}`

    const now = new Date()
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    const dateStamp = amzDate.slice(0, 8)
    // A stream cannot be hashed without buffering it, which defeats streaming.
    const payloadHash = body instanceof ReadableStream
      ? 'UNSIGNED-PAYLOAD'
      : await sha256Hex(body ?? '')

    const rawHeaders: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders,
    }
    const headers = Object.fromEntries(
      Object.entries(rawHeaders).map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')])
    )
    const sortedHeaderKeys = Object.keys(headers).sort()
    const canonicalHeaders = sortedHeaderKeys.map(header => `${header}:${headers[header]}\n`).join('')
    const signedHeaders = sortedHeaderKeys.join(';')

    const canonicalQuery = Object.keys(query).sort().map(param => `${awsUriEncode(param, true)}=${awsUriEncode(query[param], true)}`).join('&')
    const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n')

    const scope = `${dateStamp}/${config.region}/s3/aws4_request`
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n')

    const dateKey = await hmacSha256(`AWS4${config.secretAccessKey}`, dateStamp)
    const regionKey = await hmacSha256(dateKey, config.region)
    const serviceKey = await hmacSha256(regionKey, 's3')
    const signingKey = await hmacSha256(serviceKey, 'aws4_request')
    const signature = toHex(await hmacSha256(signingKey, stringToSign))

    const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    const url = `${endpoint.origin}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`
    const init: RequestInit = {
      method,
      headers: { ...headers, Authorization: authorization },
      body: body ?? undefined,
    }
    // Node needs half-duplex declared for stream bodies; workerd ignores it.
    if (body instanceof ReadableStream) (init as RequestInit & { duplex: string }).duplex = 'half'
    return fetch(url, init)
  }

  private keyFromPath(path: string): string {
    const clean = normalizeVirtualPath(path)
    return clean === '/' ? '' : clean.slice(1)
  }

  async list(path: string, pageToken?: string | null): Promise<ListResult> {
    const cleanPath = normalizeVirtualPath(path)
    const prefix = this.keyFromPath(cleanPath)
    const query: Record<string, string> = {
      'list-type': '2',
      delimiter: '/',
      'max-keys': '200',
      prefix: prefix ? `${prefix}/` : '',
    }
    if (pageToken) query['continuation-token'] = pageToken
    const response = await this.signedFetch('GET', '', query)
    if (!response.ok) throw new Error(`S3 list returned ${response.status}`)
    const xml = await response.text()

    const items: FileItem[] = []
    for (const match of xml.matchAll(/<CommonPrefixes><Prefix>([\s\S]*?)<\/Prefix><\/CommonPrefixes>/g)) {
      const key = decodeXml(match[1]).replace(/\/$/, '')
      const name = key.split('/').pop() ?? key
      items.push({
        id: encodeId(`${key}/`),
        name,
        mimeType: 'httpd/unix-directory',
        size: null,
        modifiedTime: null,
        createdTime: null,
        thumbnailLink: null,
        isFolder: true,
      })
    }
    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = match[1]
      const key = decodeXml(block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? '')
      if (!key || key.endsWith('/')) continue
      const name = key.split('/').pop() ?? key
      items.push({
        id: encodeId(key),
        name,
        mimeType: 'application/octet-stream',
        size: Number(block.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0) || null,
        modifiedTime: block.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1] ?? null,
        createdTime: null,
        thumbnailLink: null,
        isFolder: false,
      })
    }
    const tokenText = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1]
    const nextToken = tokenText ? decodeXml(tokenText) : null
    return { path: cleanPath, items, nextPageToken: nextToken }
  }

  async search(): Promise<FileItem[]> {
    throw new Error('This provider does not support: search')
  }

  async download(fileId: string, request: Request, disposition: 'attachment' | 'inline' = 'attachment'): Promise<Response> {
    const key = decodeS3Id(fileId)
    const range = request.headers.get('Range')
    // signedFetch encodes the key itself; encoding here too yields %2520 for a space.
    const upstream = await this.signedFetch('GET', key, {}, undefined, range ? { range } : undefined)
    if (!upstream.ok && upstream.status !== 206) throw new Error(`S3 download returned ${upstream.status}`)
    const filename = key.split('/').pop() || 'download'
    return providerFileResponse(upstream, filename, disposition)
  }

  async thumbnail(): Promise<Response> {
    return new Response('No thumbnail', { status: 404 })
  }

  async upload(path: string, filename: string, body: ReadableStream | ArrayBuffer, contentType: string, size: number): Promise<FileItem> {
    const prefix = this.keyFromPath(path)
    const key = prefix ? `${prefix}/${filename}` : filename
    // Content-Length is left unsigned and emitted by the runtime: signing a
    // header workerd then replaces is what breaks the signature.
    const payload = body instanceof ReadableStream ? fixedLength(body, size) : body
    const response = await this.signedFetch('PUT', key, {}, payload, { 'content-type': contentType })
    if (!response.ok) throw new Error(`S3 upload returned ${response.status}`)
    return {
      id: encodeId(key),
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
    const prefix = this.keyFromPath(path)
    const key = `${prefix ? `${prefix}/` : ''}${name}/`
    const response = await this.signedFetch('PUT', key, {}, new ArrayBuffer(0))
    if (!response.ok) throw new Error(`S3 mkdir returned ${response.status}`)
    return {
      id: encodeId(key),
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
    const key = decodeS3Id(fileId)
    // S3 has no directories: deleting the marker alone would leave every object
    // under the prefix in place and still listable.
    if (key.endsWith('/')) return this.removePrefix(key)
    return this.deleteKey(key)
  }

  private async deleteKey(key: string): Promise<void> {
    const response = await this.signedFetch('DELETE', key, {})
    if (!response.ok && response.status !== 204) throw new Error(`S3 delete returned ${response.status}`)
  }

  private async removePrefix(prefix: string): Promise<void> {
    let token: string | null = null
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': '1000' }
      if (token) query['continuation-token'] = token
      const response = await this.signedFetch('GET', '', query)
      if (!response.ok) throw new Error(`S3 list returned ${response.status}`)
      const xml = await response.text()

      const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map(match => decodeXml(match[1]))
      for (const key of keys) await this.deleteKey(key)

      token = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] ?? null
      if (token) token = decodeXml(token)
    } while (token)
  }

  async rename(fileId: string, newName: string, _path?: string): Promise<Pick<FileItem, 'id' | 'name'>> {
    const key = decodeS3Id(fileId)
    if (key.endsWith('/')) throw new HTTPException(400, { message: 'S3 folder rename is not supported' })
    const parent = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : ''
    const newKey = parent ? `${parent}/${newName}` : newName
    const config = await this.getConfig()
    const copyResponse = await this.signedFetch('PUT', newKey, {}, new ArrayBuffer(0), {
      'x-amz-copy-source': awsUriEncode(`/${config.bucket}/${key}`, false),
      'x-amz-metadata-directive': 'COPY',
    })
    if (!copyResponse.ok) throw new Error(`S3 rename (copy) returned ${copyResponse.status}`)
    // CopyObject can fail mid-copy and still answer 200 with an <Error> body.
    // Deleting the source on that reply would destroy the only copy. Only the
    // error element is required: not every S3-compatible service echoes a result.
    const report = await copyResponse.text()
    if (/<Error[\s>]/.test(report)) {
      throw new Error(`S3 rename (copy) did not complete: ${report.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? 'unknown error'}`)
    }
    await this.remove(fileId)
    return { id: encodeId(newKey), name: newName }
  }
}
