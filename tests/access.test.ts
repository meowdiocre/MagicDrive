import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { app } from '../src/worker/index'
import { consumeOAuthState, createSession } from '../src/worker/auth/session'
import { hashStorageAccessPassword, verifyStorageAccessPassword } from '../src/worker/lib/access'
import { sha256Hex } from '../src/worker/lib/crypto'
import { poolProviderPath } from '../src/worker/lib/pool'
import {
  MemoryDriver,
  identify,
  migrate,
  payload,
  registerMemoryProvider,
  testBindings,
} from './harness'
import type { DriveRecord } from '../src/worker/types'

registerMemoryProvider()

const db = new DatabaseSync(':memory:')
migrate(db)
const bindings = testBindings(db)
const password = 'correct horse battery staple'
const protectedHash = await hashStorageAccessPassword(bindings.DATA_ENCRYPTION_KEY, password)

assert.equal(await verifyStorageAccessPassword(bindings.DATA_ENCRYPTION_KEY, password, protectedHash), true)
assert.equal(await verifyStorageAccessPassword(bindings.DATA_ENCRYPTION_KEY, 'wrong password', protectedHash), false)

db.exec(`
  INSERT INTO users (id, username, spell_hash, role, created_at, updated_at) VALUES
    ('owner-1', 'ana', 'hash-ana', 'owner', '2026-01-01', '2026-01-01'),
    ('owner-2', 'ben', 'hash-ben', 'owner', '2026-01-01', '2026-01-01');
`)

const insertDrive = db.prepare(`
  INSERT INTO drives (
    id, user_id, provider, name, root_id, config_enc, granted_scope,
    access_mode, access_password_hash, created_at, updated_at
  ) VALUES (?, ?, 's3', ?, 'root', 'encrypted', '', ?, ?, '2026-01-01', '2026-01-01')
`)
insertDrive.run('drive-public', 'owner-1', 'Public storage', 'public', null)
insertDrive.run('drive-protected', 'owner-1', 'Protected storage', 'protected', protectedHash)
insertDrive.run('drive-private', 'owner-2', 'Private storage', 'private', null)

assert.throws(() => db.exec(`
  INSERT INTO drives (
    id, user_id, provider, name, root_id, config_enc, granted_scope,
    access_mode, created_at, updated_at
  ) VALUES ('invalid-mode', 'owner-1', 's3', 'Invalid', 'root', 'encrypted', '', 'hidden', 'now', 'now')
`), /CHECK constraint failed/)

const drive = (id: string, userId: string, name: string, accessMode: DriveRecord['access_mode']): DriveRecord => ({
  id, user_id: userId, provider: 's3', name, root_id: 'root',
  refresh_token_enc: null, config_enc: 'encrypted', granted_scope: '', access_mode: accessMode,
})

const publicFile = await new MemoryDriver(drive('drive-public', 'owner-1', 'Public storage', 'public'))
  .upload('/', 'public.txt', new TextEncoder().encode('public').buffer as ArrayBuffer, 'text/plain')
const protectedFile = await new MemoryDriver(drive('drive-protected', 'owner-1', 'Protected storage', 'protected'))
  .upload('/', 'protected.txt', new TextEncoder().encode('protected').buffer as ArrayBuffer, 'text/plain')
await new MemoryDriver(drive('drive-private', 'owner-2', 'Private storage', 'private'))
  .upload('/', 'private.txt', new TextEncoder().encode('private').buffer as ArrayBuffer, 'text/plain')
db.exec(`
  INSERT INTO pool_folders (id, path, name, parent_path, created_by, created_at)
  VALUES ('pool-1', '/Shared', 'Shared', '/', 'owner-1', '2026-01-01');
  INSERT INTO pool_folder_drives (folder_id, drive_id, created_at)
  VALUES ('pool-1', 'drive-private', '2026-01-01');
`)
await new MemoryDriver(drive('drive-private', 'owner-2', 'Private storage', 'private'))
  .upload(poolProviderPath('drive-private', '/Shared'), 'pooled.txt', new TextEncoder().encode('pooled').buffer as ArrayBuffer, 'text/plain')

const anonymousDrives = await payload<{ items: Array<{ id: string; locked: boolean; is_virtual: boolean }>; activeDriveId: string }>(
  await app.request('http://localhost/api/drives', undefined, bindings),
)
assert.equal(anonymousDrives.items.some(item => item.id === 'drive-public'), true)
assert.equal(anonymousDrives.items.find(item => item.id === 'drive-protected')?.locked, true)
assert.equal(anonymousDrives.items.some(item => item.id === 'drive-private'), false)
assert.equal(anonymousDrives.items.find(item => item.id === anonymousDrives.activeDriveId)?.is_virtual, true)

const publicListing = await app.request(
  'http://localhost/api/files?drive=drive-public&path=/', undefined, bindings,
)
assert.equal(publicListing.status, 200)
assert.deepEqual((await payload<{ items: Array<{ name: string }> }>(publicListing)).items.map(item => item.name), ['public.txt'])

const lockedListing = await app.request(
  'http://localhost/api/files?drive=drive-protected&path=/', undefined, bindings,
)
assert.equal(lockedListing.status, 423)

const wrongUnlock = await app.request(
  'http://localhost/api/drives/drive-protected/unlock',
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong password' }) },
  bindings,
)
assert.equal(wrongUnlock.status, 401)

const unlocked = await app.request(
  'http://localhost/api/drives/drive-protected/unlock',
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) },
  bindings,
)
assert.equal(unlocked.status, 200)
const unlockCookie = unlocked.headers.get('Set-Cookie')?.split(';')[0]
assert.ok(unlockCookie)

const protectedListing = await app.request(
  'http://localhost/api/files?drive=drive-protected&path=/',
  { headers: { Cookie: unlockCookie } },
  bindings,
)
assert.equal(protectedListing.status, 200)
assert.deepEqual((await payload<{ items: Array<{ name: string }> }>(protectedListing)).items.map(item => item.name), ['protected.txt'])

const poolListing = await payload<{ items: Array<{ name: string }> }>(await app.request(
  'http://localhost/api/files?drive=global&path=/', undefined, bindings,
))
assert.deepEqual(poolListing.items.map(item => item.name), ['Shared', 'README.md'])
const pooledPrivateListing = await payload<{ items: Array<{ name: string }> }>(await app.request(
  'http://localhost/api/files?drive=global&path=/Shared', undefined, bindings,
))
assert.deepEqual(pooledPrivateListing.items.map(item => item.name), [])
assert.equal(pooledPrivateListing.items.some(item => item.name === 'private.txt'), false)

const privateAnonymous = await app.request(
  'http://localhost/api/files?drive=drive-private&path=/', undefined, bindings,
)
assert.equal(privateAnonymous.status, 404)
const ownerToken = await createSession(bindings, { userId: 'owner-2', driveId: 'drive-private', username: 'ben' })
const privateOwner = await app.request(
  'http://localhost/api/files?drive=drive-private&path=/', identify(ownerToken), bindings,
)
assert.equal(privateOwner.status, 200)

const shareToken = 'share_token_1234567890abcd'
db.prepare(`
  INSERT INTO shares (id, drive_id, file_id, name, token_hash, created_by, created_at)
  VALUES ('share-protected', 'drive-protected', ?, 'Protected file', ?, 'owner-1', '2026-01-01')
`).run(protectedFile.id, await sha256Hex(shareToken))
const shared = await app.request(`http://localhost/s/${shareToken}`, undefined, bindings)
assert.equal(shared.status, 200)
assert.equal(await shared.text(), 'protected')

const connectorToken = await createSession(bindings, { userId: 'owner-1', driveId: 'drive-public', username: 'ana' })
const connected = await app.request(
  'http://localhost/api/drives',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...identify(connectorToken).headers as Record<string, string> },
    body: JSON.stringify({
      provider: 's3',
      name: 'New protected storage',
      accessMode: 'protected',
      password,
      poolContributor: true,
      config: {
        endpoint: 'https://s3.example.com', region: 'auto', bucket: 'bucket',
        accessKeyId: 'key', secretAccessKey: 'secret',
      },
    }),
  },
  bindings,
)
assert.equal(connected.status, 201)
const connectedRow = db.prepare(
  "SELECT access_mode, access_password_hash, pool_contributor FROM drives WHERE name = 'New protected storage'"
).get() as { access_mode: string; access_password_hash: string; pool_contributor: number }
assert.equal(connectedRow.access_mode, 'protected')
assert.equal(connectedRow.access_password_hash.includes(password), false)
assert.equal(await verifyStorageAccessPassword(bindings.DATA_ENCRYPTION_KEY, password, connectedRow.access_password_hash), true)
assert.equal(connectedRow.pool_contributor, 1)

const oauthStart = await app.request(
  'http://localhost/api/auth/google/start',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...identify(connectorToken).headers as Record<string, string> },
    body: JSON.stringify({ accessMode: 'protected', password, poolContributor: false, returnTo: '/' }),
  },
  bindings,
)
assert.equal(oauthStart.status, 200)
const oauthUrl = new URL((await payload<{ url: string }>(oauthStart)).url)
assert.equal(oauthUrl.toString().includes(encodeURIComponent(password)), false)
const oauthState = await consumeOAuthState(bindings, oauthUrl.searchParams.get('state') ?? '')
assert.equal(oauthState?.accessMode, 'protected')
assert.ok(oauthState?.accessPasswordHash)
assert.equal(oauthState.accessPasswordHash.includes(password), false)
assert.equal(await verifyStorageAccessPassword(bindings.DATA_ENCRYPTION_KEY, password, oauthState.accessPasswordHash), true)
assert.equal(oauthState.poolContributor, false)

const vaultFolderResponse = await app.request(
  'http://localhost/api/files/mkdir?drive=vault',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...identify(connectorToken).headers as Record<string, string> },
    body: JSON.stringify({ path: '/', name: 'Protected vault' }),
  },
  bindings,
)
assert.equal(vaultFolderResponse.status, 201)
const vaultFolder = await payload<{ id: string }>(vaultFolderResponse)
const protectedFolder = await app.request(
  `http://localhost/api/folders/vault/${vaultFolder.id}`,
  {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...identify(connectorToken).headers as Record<string, string> },
    body: JSON.stringify({ accessMode: 'protected', password }),
  },
  bindings,
)
assert.equal(protectedFolder.status, 200)
const vaultRoot = await payload<{ items: Array<{ name: string; locked?: boolean }> }>(await app.request(
  'http://localhost/api/files?drive=vault&path=/', undefined, bindings,
))
assert.equal(vaultRoot.items.find(item => item.name === 'Protected vault')?.locked, true)
assert.equal((await app.request('http://localhost/api/files?drive=vault&path=/Protected%20vault', undefined, bindings)).status, 423)
const unlockFolder = await app.request(
  `http://localhost/api/folders/vault/${vaultFolder.id}/unlock`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) },
  bindings,
)
assert.equal(unlockFolder.status, 200)
const vaultFolderCookie = unlockFolder.headers.get('Set-Cookie')!.split(';')[0]
assert.equal((await app.request(
  'http://localhost/api/files?drive=vault&path=/Protected%20vault',
  { headers: { Cookie: vaultFolderCookie } },
  bindings,
)).status, 200)
assert.equal((await app.request(
  `http://localhost/api/folders/vault/${vaultFolder.id}`,
  {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...identify(connectorToken).headers as Record<string, string> },
    body: JSON.stringify({ accessMode: 'private' }),
  },
  bindings,
)).status, 200)
const hiddenVault = await payload<{ items: Array<{ name: string }> }>(await app.request(
  'http://localhost/api/files?drive=vault&path=/', identify(ownerToken), bindings,
))
assert.equal(hiddenVault.items.some(item => item.name === 'Protected vault'), false)

assert.ok(publicFile.id)
db.close()
console.log('storage access checks passed')
