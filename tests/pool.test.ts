import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { app } from '../src/worker/index'
import { createSession } from '../src/worker/auth/session'
import { decodeAggregateId, encodePoolId } from '../src/worker/drivers/aggregate'
import { listFolderPolicies, verifyFolderPassword } from '../src/worker/lib/folder-access'
import { CAULDRON_README } from '../src/worker/lib/readme'
import {
  identify, memoryStores, migrate, payload, registerMemoryProvider, testBindings,
} from './harness'

registerMemoryProvider()

const db = new DatabaseSync(':memory:')
migrate(db)
db.exec(`
  INSERT INTO users (id, username, spell_hash, role, created_at, updated_at) VALUES
    ('owner-1', 'ana', 'hash-ana', 'owner', 'now', 'now'),
    ('magician-1', 'cy', 'hash-cy', 'magician', 'now', 'now');
  INSERT INTO drives (id, user_id, provider, name, root_id, config_enc, granted_scope, created_at, updated_at) VALUES
    ('drive-1', 'owner-1', 's3', 'Ana one', 'root', 'enc', '', 'now', 'now'),
    ('drive-2', 'magician-1', 's3', 'Cy two', 'root', 'enc', '', 'now', 'now');
  INSERT INTO pool_folders (id, path, name, parent_path, created_by, created_at)
  VALUES ('folder-1', '/Shared', 'Shared', '/', 'magician-1', 'now');
  INSERT INTO pool_folder_drives (folder_id, drive_id, created_at) VALUES
    ('folder-1', 'drive-1', 'now'), ('folder-1', 'drive-2', 'now');
  INSERT INTO pool_folders (id, path, name, parent_path, created_by, created_at)
  VALUES ('folder-2', '/Shared/Child', 'Child', '/Shared', 'magician-1', 'now');
  INSERT INTO pool_folder_drives (folder_id, drive_id, created_at) VALUES
    ('folder-2', 'drive-1', 'now'), ('folder-2', 'drive-2', 'now');
  INSERT INTO pool_folders (id, path, name, parent_path, created_by, access_mode, created_at)
  VALUES ('folder-orphan', '/Orphan', 'Orphan', '/', NULL, 'private', 'now');
  INSERT INTO pool_folder_drives (folder_id, drive_id, created_at)
  VALUES ('folder-orphan', 'drive-1', 'now');
`)

const bindings = testBindings(db, { MAGICIAN_USERS: 'cy', VAULT_SEGMENT_SIZE: '8' })
db.exec(`
  INSERT INTO pool_folders (id, path, name, parent_path, created_by, access_mode, created_at)
  VALUES ('folder-wildcard', '/Shared%', 'Shared%', '/', 'magician-1', 'private', 'now');
`)
assert.equal((await listFolderPolicies(bindings, 'pool', '/SharedX/Child')).some(policy => policy.id === 'folder-wildcard'), false)
const ana = await createSession(bindings, { userId: 'owner-1', driveId: 'drive-1', username: 'ana' })
const cy = await createSession(bindings, { userId: 'magician-1', driveId: 'drive-2', username: 'cy', role: 'magician' })
const json = (method: string, url: string, body: unknown, token?: string, extra: HeadersInit = {}) => app.request(
  url.startsWith('http') ? url : `http://localhost${url}`,
  {
    method,
    headers: { 'Content-Type': 'application/json', ...extra, ...(token ? { Cookie: `vd_session=${token}` } : {}) },
    body: JSON.stringify(body),
  },
  bindings,
)

const root = await payload<{ items: Array<{ id: string; name: string; system?: boolean }> }>(
  await app.request('http://localhost/api/files?drive=global&path=/', undefined, bindings),
)
assert.deepEqual(root.items.map(item => item.name), ['Shared', 'README.md'])
const readme = root.items.find(item => item.system)!
assert.equal(await (await app.request(`http://localhost/api/files/${readme.id}/raw?drive=global`, undefined, bindings)).text(), CAULDRON_README)

assert.equal((await json('POST', 'http://localhost/api/vault/uploads', {
  drive: 'global', path: '/Shared/Child', name: 'blocked.bin', size: 1,
}, ana)).status, 403)

const content = new TextEncoder().encode('the cauldron encrypts every byte')
const started = await payload<{ id: string; segmentSize: number; segmentCount: number }>(await json(
  'POST', 'http://localhost/api/vault/uploads', {
    drive: 'global', path: '/Shared/Child', name: 'secret.txt', size: content.byteLength, contentType: 'text/plain',
  }, cy,
))
assert.equal(started.segmentSize, 8)
assert.equal(started.segmentCount, Math.ceil(content.byteLength / 8))

for (let index = 0; index < started.segmentCount; index += 1) {
  const bytes = content.slice(index * 8, Math.min((index + 1) * 8, content.byteLength))
  const response = await app.request(
    `http://localhost/api/vault/uploads/${started.id}/segments/${index}?drive=global`,
    { method: 'PUT', headers: { Cookie: `vd_session=${cy}`, 'Content-Length': String(bytes.byteLength) }, body: bytes.buffer },
    bindings,
  )
  assert.equal(response.status, 200)
}
assert.equal((await json('POST', `http://localhost/api/vault/uploads/${started.id}/commit?drive=global`, {}, cy)).status, 200)

const object = db.prepare('SELECT id FROM pool_objects WHERE path = ?').get('/Shared/Child/secret.txt') as { id: string }
const segments = db.prepare('SELECT drive_id, size FROM pool_segments WHERE object_id = ? ORDER BY idx').all(object.id) as Array<{ drive_id: string; size: number }>
assert.equal(segments.length, started.segmentCount)
assert.ok(new Set(segments.map(segment => segment.drive_id)).size >= 2)
for (const segment of segments) assert.equal(segment.size <= 8, true)
for (const [driveId, store] of memoryStores) {
  if (driveId !== 'drive-1' && driveId !== 'drive-2') continue
  for (const [key, value] of store) {
    if (!key.includes(`MagicCauldron/objects/${object.id}/`)) continue
    assert.notDeepEqual(value.bytes, content)
  }
}

const listed = await payload<{ items: Array<{ id: string; name: string }> }>(await app.request(
  'http://localhost/api/files?drive=global&path=/Shared/Child', undefined, bindings,
))
const file = listed.items.find(item => item.name === 'secret.txt')!
assert.equal(decodeAggregateId(file.id).driveId, 'managed')
const downloaded = await app.request(`http://localhost/api/files/${file.id}/download?drive=global`, undefined, bindings)
assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), content)

const capacity = await payload<{ managedBytes: number }>(await app.request(
  'http://localhost/api/capacity?drive=global', identify(cy), bindings,
))
assert.equal(capacity.managedBytes, content.byteLength)

const shareResponse = await json('POST', 'http://localhost/api/shares', {
  fileId: file.id, driveId: 'global', name: 'secret.txt',
}, cy)
assert.equal(shareResponse.status, 201)
const share = await payload<{ id: string; url: string }>(shareResponse)
assert.equal((db.prepare('SELECT drive_id FROM shares WHERE id = ?').get(share.id) as { drive_id: string | null }).drive_id, null)
const shared = await app.request(`http://localhost${share.url}`, undefined, bindings)
assert.deepEqual(new Uint8Array(await shared.arrayBuffer()), content)

const policyResponse = await json('PATCH', `/api/folders/pool/${encodePoolId('/Shared')}`, {
  accessMode: 'protected', password: 'folder-password',
}, cy)
assert.equal(policyResponse.status, 200)
const policy = db.prepare('SELECT access_password_hash FROM pool_folders WHERE id = ?').get('folder-1') as { access_password_hash: string }
assert.equal(await verifyFolderPassword(bindings.DATA_ENCRYPTION_KEY, 'folder-password', policy.access_password_hash), true)
assert.equal(policy.access_password_hash.includes('pbkdf2'), false)

const lockedRoot = await payload<{ items: Array<{ name: string; locked?: boolean }> }>(await app.request(
  'http://localhost/api/files?drive=global&path=/', undefined, bindings,
))
assert.equal(lockedRoot.items.find(item => item.name === 'Shared')?.locked, true)
assert.equal((await app.request('http://localhost/api/files?drive=global&path=/Shared', undefined, bindings)).status, 423)
assert.equal((await json('POST', `/api/folders/pool/${encodePoolId('/Shared')}/unlock`, { password: 'wrong' })).status, 401)
const unlocked = await json('POST', `/api/folders/pool/${encodePoolId('/Shared')}/unlock`, { password: 'folder-password' })
assert.equal(unlocked.status, 200)
const folderCookie = unlocked.headers.get('Set-Cookie')!.split(';')[0]
const unlockedHeaders = { Cookie: `vd_session=${cy}; ${folderCookie}` }
assert.equal((await app.request('http://localhost/api/files?drive=global&path=/Shared', { headers: unlockedHeaders }, bindings)).status, 200)
assert.equal((await app.request(`http://localhost/api/files/${file.id}/download?drive=global`, { headers: { Cookie: folderCookie } }, bindings)).status, 200)
assert.equal((await app.request(`http://localhost/api/search?drive=global&q=secret`, undefined, bindings)).status, 200)
assert.deepEqual((await payload<{ items: unknown[] }>(await app.request('http://localhost/api/search?drive=global&q=secret', undefined, bindings))).items, [])
assert.equal((await json('PATCH', `/api/folders/pool/${encodePoolId('/Shared')}`, {
  accessMode: 'protected', password: 'replacement-password',
}, cy)).status, 200)
assert.equal((await app.request(
  'http://localhost/api/files?drive=global&path=/Shared',
  { headers: { Cookie: folderCookie } },
  bindings,
)).status, 423)

assert.equal((await app.request(
  'http://localhost/api/drives/drive-1',
  { method: 'DELETE', ...identify(ana) },
  bindings,
)).status, 409)
assert.equal((await json('PATCH', `/api/folders/pool/${encodePoolId('/Shared')}`, { accessMode: 'private' }, cy, unlockedHeaders)).status, 200)
assert.equal((await app.request('http://localhost/api/files?drive=global&path=/', undefined, bindings)).status, 200)
const hidden = await payload<{ items: Array<{ name: string }> }>(await app.request(
  'http://localhost/api/files?drive=global&path=/', identify(ana), bindings,
))
assert.equal(hidden.items.some(item => item.name === 'Shared'), false)
const magicianPrivate = await payload<{ items: Array<{ name: string }> }>(await app.request(
  'http://localhost/api/files?drive=global&path=/', identify(cy), bindings,
))
assert.equal(magicianPrivate.items.some(item => item.name === 'Shared'), true)

const directContent = new TextEncoder().encode('direct')
const directUpload = await app.request(
  'http://localhost/api/files/upload?drive=global&path=/Shared&name=direct.txt',
  {
    method: 'POST',
    headers: { Cookie: `vd_session=${cy}`, 'Content-Length': String(directContent.byteLength) },
    body: directContent.buffer,
  },
  bindings,
)
assert.equal(directUpload.status, 201)
const directObject = db.prepare(
  'SELECT segment_size FROM pool_objects WHERE path = ?'
).get('/Shared/direct.txt') as { segment_size: number }
assert.equal(directObject.segment_size, 8)

db.close()
console.log('encrypted Cauldron and recursive folder access checks passed')
