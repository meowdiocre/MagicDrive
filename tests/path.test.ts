import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { escapeDriveQuery, normalizeVirtualPath, pathParts } from '../src/worker/lib/path'
import { decryptSecret, encryptSecret, hmacSha256, sha256, sha256Hex, toHex } from '../src/worker/lib/crypto'
import { decodeBase64UrlUtf8, encodeBase64UrlUtf8 } from '../src/worker/lib/base64'
import { providerFileResponse } from '../src/worker/lib/file-response'
import { summarizeCapacity, type CapacitySummary } from '../src/worker/lib/capacity'
import { readTextPreview } from '../src/web/features/files/readTextPreview'
import { formatBytes } from '../src/web/lib/format'
import { driveHref, driveIdFromSearch, resolveDriveId } from '../src/web/features/storage/driveRoute'
import { app } from '../src/worker/index'

assert.equal(normalizeVirtualPath('/Photos//2026/../2025/'), '/Photos/2025')
assert.equal(normalizeVirtualPath('\\Docs\\Invoices'), '/Docs/Invoices')
assert.deepEqual(pathParts('/Docs/Quarter 1'), ['Docs', 'Quarter 1'])
assert.equal(escapeDriveQuery("Owner's \\ files"), "Owner\\'s \\\\ files")
assert.throws(() => normalizeVirtualPath(`/${'a'.repeat(2049)}`), /Invalid path/)
assert.equal(driveIdFromSearch('?drive=drive-123'), 'drive-123')
assert.equal(driveIdFromSearch('?drive=../../private'), '')
assert.equal(resolveDriveId([{ id: 'public-1', is_virtual: false }], 'public-1', 'global'), 'public-1')
assert.equal(resolveDriveId([{ id: 'public-1', is_virtual: false }], 'missing', 'global'), 'global')
assert.equal(driveHref('https://drive.example/?theme=dark', { id: 'public-1', is_virtual: false }), '/?theme=dark&drive=public-1')
assert.equal(driveHref('https://drive.example/?drive=public-1', { id: 'global', is_virtual: true }), '/')
assert.equal(driveHref('https://drive.example/', { id: 'vault', is_virtual: true }), '/?drive=vault')

// Known-answer vectors: the S3 request signer is built on these.
assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
assert.equal(await sha256Hex(new TextEncoder().encode('abc')), await sha256Hex('abc'))
assert.equal(
  toHex(await hmacSha256('key', 'The quick brown fox jumps over the lazy dog')),
  'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
)
assert.equal(
  toHex(await hmacSha256(await sha256('k'), 'data')),
  toHex(await hmacSha256(new Uint8Array(await sha256('k')), 'data')),
)

const encrypted = await encryptSecret('test-encryption-key', 'refresh-token')
assert.equal(await decryptSecret('test-encryption-key', encrypted), 'refresh-token')
assert.notEqual(encrypted, await encryptSecret('test-encryption-key', 'refresh-token'))

const bindings = {
  GOOGLE_CLIENT_ID: 'client',
  GOOGLE_CLIENT_SECRET: 'secret',
  DATA_ENCRYPTION_KEY: 'encryption-key',
} as never

const health = await app.request('http://localhost/api/health', undefined, bindings)
assert.equal(health.status, 200)
assert.equal((await health.json() as { data: { configured: boolean } }).data.configured, true)

// Without Google secrets the app still runs; only the Drive connector drops out.
const bare = await app.request('http://localhost/api/health', undefined, { DATA_ENCRYPTION_KEY: 'k' } as never)
assert.deepEqual((await bare.json() as { data: { providers: string[] } }).data.providers, ['webdav', 's3'])

const badShare = await app.request('http://localhost/s/short', undefined, bindings)
assert.equal(badShare.status, 400)

// Share links are per-user, so listing them still needs a session.
const unauthedShares = await app.request('http://localhost/api/shares', undefined, bindings)
assert.equal(unauthedShares.status, 401)

// Reads are public; writes are not.
const anonWrites: [string, RequestInit][] = [
  ['http://localhost/api/files/upload?name=x.txt', { method: 'POST' }],
  ['http://localhost/api/files/mkdir', { method: 'POST' }],
  ['http://localhost/api/files/abcdef', { method: 'PATCH' }],
  ['http://localhost/api/files/abcdef', { method: 'DELETE' }],
  ['http://localhost/api/drives', { method: 'POST' }],
  ['http://localhost/api/drives/abc', { method: 'DELETE' }],
  ['http://localhost/api/shares', { method: 'POST' }],
]
for (const [url, init] of anonWrites) {
  const response = await app.request(url, init, bindings)
  assert.equal(response.status, 401, `${init.method} ${url} should reject anonymous writes`)
}

// Google is a storage connector now, so its endpoints need an account first.
assert.equal((await app.request(
  'http://localhost/api/auth/google/start',
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  bindings,
)).status, 401, 'Google OAuth start should require a session')
assert.equal((await app.request(
  'http://localhost/api/auth/google/callback', undefined, bindings,
)).status, 401, 'Google OAuth callback should require a session')

const { decodeWebDavId, decodeXmlEntities } = await import('../src/worker/drivers/webdav')
assert.equal(decodeWebDavId(btoa('/docs/report.pdf').replaceAll('=', '')), '/docs/report.pdf')
assert.equal(decodeWebDavId(encodeBase64UrlUtf8('/文件/報告.txt')), '/文件/報告.txt')
assert.throws(() => decodeWebDavId(btoa('/../etc/passwd').replaceAll('=', '')), /Invalid file ID/)
assert.equal(decodeXmlEntities('R&amp;D &lt;2026&gt; &#x1F9D9;'), 'R&D <2026> 🧙')

const { S3Driver, awsUriEncode, decodeS3Id } = await import('../src/worker/drivers/s3')
assert.equal(decodeS3Id(btoa('photos/2026/cat.jpg').replaceAll('=', '')), 'photos/2026/cat.jpg')
assert.equal(decodeS3Id(encodeBase64UrlUtf8('photos/🐈.jpg')), 'photos/🐈.jpg')
// fetch() normalizes these out of the URL, so the signature could never match.
assert.throws(() => decodeS3Id(encodeBase64UrlUtf8('photos/../secret.txt')), /cannot be addressed/)
assert.throws(() => decodeS3Id(encodeBase64UrlUtf8('photos/./cat.jpg')), /cannot be addressed/)
assert.equal(decodeS3Id(encodeBase64UrlUtf8('photos/..hidden/cat.jpg')), 'photos/..hidden/cat.jpg')
assert.equal(awsUriEncode('photos/🐈.jpg', false), 'photos/%F0%9F%90%88.jpg')
assert.equal(awsUriEncode("a b!'()*.txt", true), 'a%20b%21%27%28%29%2A.txt')
assert.equal(decodeBase64UrlUtf8(encodeBase64UrlUtf8('ไทย/文件')), 'ไทย/文件')

const folderId = encodeBase64UrlUtf8('photos/')
await assert.rejects(
  new S3Driver({} as never, {} as never).rename(folderId, 'renamed'),
  /S3 folder rename is not supported/,
)

const { encodeAggregateId, decodeAggregateId } = await import('../src/worker/drivers/aggregate')
for (const [driveId, fileId] of [
  ['6e72ec33-241c-4039-bbe5-1f359afcb240', '18avV3MTj1kihI_6XIij-7HcFKBoLDXb3'],
  ['d', 'x'],
  ['drive-1', btoa('/docs/report.pdf').replaceAll('=', '')],
] as const) {
  const encoded = encodeAggregateId(driveId, fileId)
  // Must survive the same character-class validation as real provider ids.
  assert.match(encoded, /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(decodeAggregateId(encoded), { driveId, id: fileId })
}
assert.throws(() => decodeAggregateId('!!!not-base64!!!'), /Invalid file ID/)
assert.throws(() => decodeAggregateId(btoa('nopipe').replaceAll('=', '')), /Invalid file ID/)

// Google write capability is derived from the granted scope, not assumed.
const { grantsWrite } = await import('../src/worker/drivers/google')
assert.equal(grantsWrite('openid email https://www.googleapis.com/auth/drive.readonly'), false)
assert.equal(grantsWrite('openid email https://www.googleapis.com/auth/drive'), true)
assert.equal(grantsWrite('https://www.googleapis.com/auth/drive.file'), true)
assert.equal(grantsWrite(''), false)
// drive.readonly must not match by prefix against auth/drive.
assert.equal(grantsWrite('https://www.googleapis.com/auth/drive.readonly'), false)

const { decodeXml } = await import('../src/worker/drivers/s3')
assert.equal(decodeXml('report &amp; notes.txt'), 'report & notes.txt')
assert.equal(decodeXml('a &lt;b&gt; c'), 'a <b> c')
// &amp;lt; must decode to the literal "&lt;", not to "<".
assert.equal(decodeXml('&amp;lt;'), '&lt;')

const proxied = providerFileResponse(new Response('data', {
  status: 206,
  headers: { 'Content-Type': 'text/plain', 'Content-Range': 'bytes 0-3/4' },
}), 'résumé".txt', 'inline')
assert.equal(proxied.status, 206)
assert.equal(proxied.headers.get('Content-Type'), 'text/plain')
assert.match(proxied.headers.get('Content-Disposition') ?? '', /^inline;/)
assert.match(proxied.headers.get('Content-Disposition') ?? '', /filename\*=UTF-8''r%C3%A9sum%C3%A9%22.txt/)
assert.equal(await proxied.text(), 'data')

assert.equal(await readTextPreview(new Response('abcdef'), 4), 'abcd')
assert.equal(formatBytes(0), '0 B')
assert.equal(formatBytes(1024 ** 4 + 512 * 1024 ** 3, 2), '1.50 TB')
assert.equal((await app.request(`http://localhost/api/search?q=${'x'.repeat(49)}`, undefined, bindings)).status, 400)

const status = (usage: { usedBytes: number | null; totalBytes: number | null; freeBytes: number | null } | null, ok = true) => ({
  usage,
  health: { ok },
  checkedAt: 'now',
})
const aggregate = summarizeCapacity([
  status({ usedBytes: 20, totalBytes: 100, freeBytes: 80 }),
  status({ usedBytes: null, totalBytes: 200, freeBytes: 150 }),
  status({ usedBytes: 1, totalBytes: null, freeBytes: null }),
  status(null, false),
], 1)
assert.deepEqual(aggregate, {
  usedBytes: 70,
  totalBytes: 300,
  freeBytes: 230,
  knownStorages: 2,
  unknownStorages: 1,
  unavailableStorages: 2,
} satisfies CapacitySummary)
assert.deepEqual(summarizeCapacity([status({ usedBytes: 25, totalBytes: 100, freeBytes: null })]), {
  usedBytes: 25,
  totalBytes: 100,
  freeBytes: 75,
  knownStorages: 1,
  unknownStorages: 0,
  unavailableStorages: 0,
})

const migrationDb = new DatabaseSync(':memory:')
migrationDb.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'))
const schemaNames = (type: 'table' | 'index' | 'trigger') => migrationDb
  .prepare("SELECT name FROM sqlite_master WHERE type = ? AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all(type)
  .map(row => (row as { name: string }).name)
assert.deepEqual(schemaNames('table'), [
  'drives', 'login_attempts', 'pool_deletions', 'pool_folder_drives', 'pool_folders',
  'shares', 'users', 'vault_objects', 'vault_segments',
])
assert.deepEqual(schemaNames('index'), [
  'idx_drives_user_id', 'idx_login_attempts_expiry', 'idx_pool_folder_drives_drive_id',
  'idx_pool_folders_parent_path', 'idx_shares_drive_id', 'idx_shares_virtual_drive_id',
  'idx_vault_objects_parent', 'idx_vault_objects_path_nocase', 'idx_vault_objects_status',
])
assert.deepEqual(schemaNames('trigger'), ['prevent_user_delete_with_vault_objects'])

migrationDb.exec(`
  INSERT INTO users (id, username, spell_hash, role, created_at, updated_at)
  VALUES ('user-1', 'owner', 'spell-hash', 'owner', 'now', 'now');
  INSERT INTO drives (id, user_id, provider, provider_variant, name, root_id, config_enc, granted_scope, created_at, updated_at)
  VALUES ('drive-1', 'user-1', 's3', 'r2', 'Storage', 'root', 'encrypted', '', 'now', 'now');
  INSERT INTO shares (id, drive_id, file_id, name, token_hash, created_by, created_at)
  VALUES ('share-1', 'drive-1', 'file-1', 'File', 'share-hash', 'user-1', 'now');
  INSERT INTO pool_folders (id, path, name, parent_path, created_by, created_at)
  VALUES ('pool-1', '/Shared', 'Shared', '/', 'user-1', 'now');
  INSERT INTO pool_folder_drives (folder_id, drive_id, created_at)
  VALUES ('pool-1', 'drive-1', 'now');
  INSERT INTO vault_objects (id, parent_path, name, path, kind, owner, status, created_at, updated_at)
  VALUES ('vault-1', '/', 'Docs', '/Docs', 'folder', 'user-1', 'ready', 'now', 'now');
  INSERT INTO login_attempts (address_hash, attempts, expires_at)
  VALUES ('address-hash', 1, 'later');
`)
assert.equal(
  (migrationDb.prepare("SELECT provider_variant FROM drives WHERE id = 'drive-1'").get() as { provider_variant: string }).provider_variant,
  'r2',
)
assert.throws(() => migrationDb.exec(`
  INSERT INTO vault_objects (id, parent_path, name, path, kind, owner, status, created_at, updated_at)
  VALUES ('vault-2', '/', 'docs', '/docs', 'folder', 'user-1', 'ready', 'now', 'now')
`), /UNIQUE constraint failed/)
assert.throws(() => migrationDb.exec("DELETE FROM users WHERE id = 'user-1'"), /MagicVault objects/)
migrationDb.close()

console.log('path, crypto, and Worker checks passed')
