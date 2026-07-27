import { GoogleDriveDriver } from './google'
import { WebDavDriver } from './webdav'
import { S3Driver } from './s3'
import type { Capability, StorageDriver } from './contract'
import type { Bindings, DriveRecord, S3Config, WebDavConfig } from '../types'

export interface ProviderField {
  key: string
  label: string
  type?: 'text' | 'password'
  placeholder?: string
  /** Prefilled and editable, for presets where the value is nearly always the same. */
  value?: string
  hint?: string
}

/**
 * One entry per connectable provider. Presets are full entries that reuse a base
 * connector: they carry their own labels and prefilled fields, but drives are
 * stored under the base id, so the database schema never learns about presets.
 */
export interface ProviderDefinition {
  id: string
  label: string
  base: 'google' | 'webdav' | 's3'
  auth: 'oauth' | 'config'
  capabilities: readonly Capability[]
  fields: ProviderField[]
}

type DriverFactory = (env: Bindings, drive: DriveRecord) => StorageDriver

const factories = new Map<string, DriverFactory>([
  ['google', (env, drive) => new GoogleDriveDriver(env, drive)],
  ['webdav', (env, drive) => new WebDavDriver(env, drive)],
  ['s3', (env, drive) => new S3Driver(env, drive)],
])

/** Test seam: swap a base connector for a fake without touching the routes. */
export function registerDriverFactory(id: string, factory: DriverFactory): void {
  factories.set(id, factory)
}

export function createDriver(env: Bindings, drive: DriveRecord): StorageDriver {
  const factory = factories.get(drive.provider)
  if (!factory) throw new Error(`Unknown provider: ${drive.provider as string}`)
  return factory(env, drive)
}

const GOOGLE_CAPABILITIES: readonly Capability[] = ['list', 'search', 'download', 'upload', 'mkdir', 'delete', 'rename', 'thumbnail']
const WEBDAV_CAPABILITIES: readonly Capability[] = ['list', 'download', 'upload', 'mkdir', 'delete', 'rename']
const S3_CAPABILITIES: readonly Capability[] = WEBDAV_CAPABILITIES

const WEBDAV_FIELDS: ProviderField[] = [
  { key: 'url', label: 'WebDAV URL', placeholder: 'https://dav.example.com/remote.php/webdav' },
  { key: 'username', label: 'Username' },
  { key: 'password', label: 'Password', type: 'password' },
]

function s3Fields(overrides: Partial<Record<'endpoint' | 'region', ProviderField>> = {}): ProviderField[] {
  return [
    overrides.endpoint ?? { key: 'endpoint', label: 'Endpoint URL', placeholder: 'https://s3.example.com' },
    overrides.region ?? { key: 'region', label: 'Region', placeholder: 'auto' },
    { key: 'bucket', label: 'Bucket' },
    { key: 'accessKeyId', label: 'Access key ID' },
    { key: 'secretAccessKey', label: 'Secret access key', type: 'password' },
  ]
}

export const PROVIDERS: ProviderDefinition[] = [
  {
    id: 'google', label: 'Google Drive', base: 'google', auth: 'oauth',
    capabilities: GOOGLE_CAPABILITIES, fields: [],
  },
  {
    id: 'webdav', label: 'WebDAV', base: 'webdav', auth: 'config',
    capabilities: WEBDAV_CAPABILITIES, fields: WEBDAV_FIELDS,
  },
  {
    id: 's3', label: 'S3-compatible', base: 's3', auth: 'config',
    capabilities: S3_CAPABILITIES,
    fields: s3Fields({ endpoint: { key: 'endpoint', label: 'Endpoint URL', placeholder: 'https://<account>.r2.cloudflarestorage.com' } }),
  },
  {
    id: 'r2', label: 'Cloudflare R2', base: 's3', auth: 'config',
    capabilities: S3_CAPABILITIES,
    fields: s3Fields({
      endpoint: { key: 'endpoint', label: 'Endpoint URL', placeholder: 'https://<account-id>.r2.cloudflarestorage.com', hint: 'Account ID is on the R2 overview page.' },
      region: { key: 'region', label: 'Region', value: 'auto' },
    }),
  },
  {
    id: 'b2', label: 'Backblaze B2', base: 's3', auth: 'config',
    capabilities: S3_CAPABILITIES,
    fields: s3Fields({
      endpoint: { key: 'endpoint', label: 'Endpoint URL', placeholder: 'https://s3.us-west-004.backblazeb2.com', hint: 'Shown on the bucket page. keyID goes in access key, applicationKey in secret key.' },
      region: { key: 'region', label: 'Region', placeholder: 'us-west-004' },
    }),
  },
  {
    id: 'wasabi', label: 'Wasabi', base: 's3', auth: 'config',
    capabilities: S3_CAPABILITIES,
    fields: s3Fields({
      endpoint: { key: 'endpoint', label: 'Endpoint URL', placeholder: 'https://s3.us-east-1.wasabisys.com' },
      region: { key: 'region', label: 'Region', value: 'us-east-1' },
    }),
  },
  {
    id: 'spaces', label: 'DO Spaces', base: 's3', auth: 'config',
    capabilities: S3_CAPABILITIES,
    fields: s3Fields({
      endpoint: { key: 'endpoint', label: 'Endpoint URL', placeholder: 'https://nyc3.digitaloceanspaces.com' },
      region: { key: 'region', label: 'Region', placeholder: 'nyc3' },
    }),
  },
  {
    id: 'minio', label: 'MinIO', base: 's3', auth: 'config',
    capabilities: S3_CAPABILITIES,
    fields: s3Fields({
      endpoint: { key: 'endpoint', label: 'Endpoint URL', placeholder: 'https://minio.example.com', hint: 'HTTPS only. Path-style requests are used automatically.' },
      region: { key: 'region', label: 'Region', value: 'us-east-1' },
    }),
  },
  {
    id: 'nextcloud', label: 'Nextcloud', base: 'webdav', auth: 'config',
    capabilities: WEBDAV_CAPABILITIES,
    fields: [
      { key: 'url', label: 'WebDAV URL', placeholder: 'https://cloud.example.com/remote.php/dav/files/USERNAME', hint: 'Files app > Settings shows your exact WebDAV address.' },
      { key: 'username', label: 'Username' },
      { key: 'password', label: 'App password', type: 'password', hint: 'Create one under Security settings; your login password may be rejected.' },
    ],
  },
  {
    id: 'owncloud', label: 'ownCloud', base: 'webdav', auth: 'config',
    capabilities: WEBDAV_CAPABILITIES,
    fields: [
      { key: 'url', label: 'WebDAV URL', placeholder: 'https://cloud.example.com/remote.php/webdav' },
      { key: 'username', label: 'Username' },
      { key: 'password', label: 'Password', type: 'password' },
    ],
  },
  {
    id: 'synology', label: 'Synology NAS', base: 'webdav', auth: 'config',
    capabilities: WEBDAV_CAPABILITIES,
    fields: [
      { key: 'url', label: 'WebDAV URL', placeholder: 'https://nas.example.com:5006', hint: 'Install and enable the WebDAV Server package; 5006 is its HTTPS port.' },
      { key: 'username', label: 'Username' },
      { key: 'password', label: 'Password', type: 'password' },
    ],
  },
]

export function providerById(id: string): ProviderDefinition | undefined {
  return PROVIDERS.find(entry => entry.id === id)
}

type Validated =
  | { ok: WebDavConfig | S3Config }
  | { error: string }

/** Shared by every preset of the same base, so a preset can never weaken validation. */
export function validateConfig(base: 'webdav' | 's3', config: Record<string, string>): Validated {
  if (base === 'webdav') {
    const { url, username, password } = config
    if (!url || !isHttpsUrl(url)) return { error: 'A valid HTTPS WebDAV URL is required' }
    if (username === undefined || password === undefined) return { error: 'username and password are required' }
    return { ok: { url, username, password } }
  }
  for (const field of ['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'] as const) {
    if (!config[field]) return { error: `${field} is required` }
  }
  if (!isHttpsUrl(config.endpoint)) return { error: 'A valid HTTPS S3 endpoint URL is required' }
  return {
    ok: {
      endpoint: config.endpoint, region: config.region, bucket: config.bucket,
      accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey,
    },
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
