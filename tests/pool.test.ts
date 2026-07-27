import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  AggregateDriver,
  POOL_FOLDER_MIME,
  POOL_NAME,
  decodeAggregateId,
  encodeAggregateId,
  encodePoolFileId,
  encodePoolId,
  verifyPoolFileId,
} from '../src/worker/drivers/aggregate'
import { magicianUser } from '../src/worker/auth/session'
import { escapeLike, joinVirtualPath } from '../src/worker/lib/path'
import { poolProviderPath } from '../src/worker/lib/pool'
import {
  identify, memoryStores, memoryUploadFailing, migrate, payload, registerMemoryProvider, testBindings,
} from './harness'
import { MemoryDriver } from './harness'
import type { DriveRecord, PoolFolderRecord } from '../src/worker/types'

const connection = (id: string, name: string): DriveRecord => ({
  id, user_id: `owner-${id}`, provider: 's3', name,
  root_id: 'root', refresh_token_enc: null, config_enc: null, granted_scope: '',
})

const conjured = (name: string): PoolFolderRecord => ({
  id: `pool-${name}`, path: `/${name}`, name, parent_path: '/', created_by: 'magician-1',
})

// The pooled view only reaches a provider once a path routes to one, so these
// checks run against an empty environment.
const noEnv = {} as never
const pool = (roots: PoolFolderRecord[], drives: DriveRecord[], isMagician: boolean) =>
  new AggregateDriver(noEnv, drives, roots, { userId: 'magician-1', isMagician })

assert.equal(joinVirtualPath('/', 'Shared'), '/Shared')
assert.equal(joinVirtualPath('/Shared', '2026'), '/Shared/2026')
assert.equal(escapeLike('/100%_done'), '/100\\%\\_done')

// Magicians are named one at a time, and "*" is not a name.
assert.equal(magicianUser('anyone', '*'), false)
assert.equal(magicianUser('cy', 'cy, dee'), true)
assert.equal(magicianUser('Cy', 'cy'), true)
assert.equal(magicianUser('ana', ''), false)
assert.equal(magicianUser('ana', undefined), false)

// Ids: a folder is addressed by its virtual path, a file by the connection holding it.
assert.deepEqual(decodeAggregateId(encodePoolId('/Shared/2026')), { driveId: 'pool', id: '/Shared/2026' })
// A pooled file id is tagged, so it cannot be typed by hand.
const taggedId = await encodePoolFileId('encryption-key', 'drive-1', 'file-9')
const taggedParts = decodeAggregateId(taggedId)
assert.equal(taggedParts.driveId, 'pool:drive-1')
assert.match(taggedParts.id, /^file-9\|[0-9a-f]{16}$/)
assert.equal(await verifyPoolFileId('encryption-key', 'drive-1', taggedParts.id), 'file-9')
// Wrong key, wrong drive, missing tag, or a forged one: all refused.
assert.equal(await verifyPoolFileId('other-key', 'drive-1', taggedParts.id), null)
assert.equal(await verifyPoolFileId('encryption-key', 'drive-2', taggedParts.id), null)
assert.equal(await verifyPoolFileId('encryption-key', 'drive-1', 'file-9'), null)
assert.equal(await verifyPoolFileId('encryption-key', 'drive-1', 'file-9|0000000000000000'), null)
// Only the first separator counts, so a folder name may contain one.
assert.deepEqual(decodeAggregateId(encodePoolId('/a|b')), { driveId: 'pool', id: '/a|b' })
assert.match(encodePoolId('/Shared'), /^[A-Za-z0-9_-]+$/)


const drives = [connection('drive-1', "Ana's bucket"), connection('drive-2', "Ben's bucket")]
const magician = pool([conjured('Shared')], drives, true)
const member = pool([conjured('Shared')], drives, false)

// The root exposes only pool-managed folders, never contributor drive names.
const root = await magician.list('/')
assert.deepEqual(root.items.map(item => item.name), ['Shared'])
assert.deepEqual(root.items.map(item => item.mimeType), [POOL_FOLDER_MIME])
assert.equal(root.items.every(item => item.isFolder), true)
assert.equal(root.nextPageToken, null)

// Contributor names never enter the public namespace.
const collision = pool([conjured('Shared')], [connection('drive-1', 'Shared')], true)
assert.deepEqual((await collision.list('/')).items.map(item => item.name), ['Shared'])

// Only a magician writes, and only inside the pool's own folders.
assert.deepEqual([...magician.allowed('/')], ['list', 'search', 'download', 'thumbnail', 'mkdir'])
assert.equal(magician.allowed('/Shared').includes('upload'), true)
assert.equal(magician.allowed('/Shared/2026').includes('delete'), true)
// A contributor's own subtree stays read-only here, whoever is asking.
assert.equal(magician.allowed("/Ana's bucket").includes('upload'), false)
assert.equal(magician.allowed("/Ana's bucket/Photos").includes('mkdir'), false)
for (const path of ['/', '/Shared', "/Ana's bucket"]) {
  assert.deepEqual([...member.allowed(path)], ['list', 'search', 'download', 'thumbnail'])
}

await assert.rejects(magician.conjureFolder("/Ana's bucket", 'Reports'), new RegExp(POOL_NAME))
await assert.rejects(magician.conjureFolder('/', 'Shared'), /already exists/)
await assert.rejects(
  pool([], [], true).conjureFolder('/', 'Shared'),
  /No storage is connected yet/,
)

await assert.rejects(
  magician.upload('/', 'notes.txt', new ArrayBuffer(1), 'text/plain', 1),
  /only be added inside a folder/,
)
await assert.rejects(
  magician.upload("/Ana's bucket", 'notes.txt', new ArrayBuffer(1), 'text/plain', 1),
  /only be added inside a folder/,
)

// A pooled folder is the same folder on every connection, so one name change cannot stand.
await assert.rejects(magician.rename(encodePoolId('/Shared'), 'Archive'), /cannot be renamed/)
// Reaching a contributor's own file through the pooled view is refused.
await assert.rejects(magician.rename(encodeAggregateId('drive-1', 'file-9'), 'x'), /Switch to that storage/)
await assert.rejects(magician.remove(encodeAggregateId('drive-1', 'file-9')), /Switch to that storage/)
await assert.rejects(magician.remove(encodePoolId("/Ana's bucket")), /can be removed from here/)
await assert.rejects(magician.remove(encodePoolId('/')), /can be removed from here/)

const db = new DatabaseSync(':memory:')
migrate(db)
db.exec(`
  INSERT INTO users (id, username, spell_hash, role, created_at, updated_at)
  VALUES ('user-1', 'ana', 'hash-ana', 'owner', 'now', 'now');
  INSERT INTO drives (id, user_id, provider, name, root_id, config_enc, granted_scope, created_at, updated_at)
  VALUES ('drive-1', 'user-1', 's3', 'Ana''s bucket', 'root', 'encrypted', '', 'now', 'now');
  INSERT INTO shares (id, drive_id, file_id, name, token_hash, created_by, created_at)
  VALUES ('share-1', 'drive-1', 'file-1', 'File', 'hash-1', 'user-1', 'now');
`)

const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
assert.equal(count('users'), 1)
assert.equal(count('drives'), 1)
assert.equal(count('shares'), 1)
assert.equal(count('pool_folders'), 0)

db.exec(`
  INSERT INTO users (id, username, spell_hash, role, created_at, updated_at)
  VALUES ('user-3', 'cy', 'hash-of-a-spell', 'magician', 'now', 'now');
  INSERT INTO pool_folders (id, path, name, parent_path, created_by, created_at)
  VALUES ('pool-1', '/Shared', 'Shared', '/', 'user-3', 'now');
`)
assert.throws(() => db.exec(
  `INSERT INTO users (id, username, spell_hash, role, created_at, updated_at)
   VALUES ('user-4', 'dee', 'another-hash', 'wizard', 'now', 'now')`
), /CHECK constraint failed/)
// One spell opens one account.
assert.throws(() => db.exec(
  `INSERT INTO users (id, username, spell_hash, role, created_at, updated_at)
   VALUES ('user-5', 'dee', 'hash-of-a-spell', 'owner', 'now', 'now')`
), /UNIQUE constraint failed/)
assert.throws(() => db.exec(
  `INSERT INTO pool_folders (id, path, name, parent_path, created_by, created_at)
   VALUES ('pool-2', '/Shared', 'Shared', '/', 'user-3', 'now')`
), /UNIQUE constraint failed/)

// The namespace outlives the magician who conjured it: it still exists on every connection.
db.exec("DELETE FROM users WHERE id = 'user-3'")
assert.equal(count('pool_folders'), 1)
assert.equal(
  (db.prepare("SELECT created_by FROM pool_folders WHERE id = 'pool-1'").get() as { created_by: string | null }).created_by,
  null,
)
db.close()

// --- Routes, over the real schema -------------------------------------------

const { app } = await import('../src/worker/index')
const { createSession } = await import('../src/worker/auth/session')
registerMemoryProvider()

const routeDb = new DatabaseSync(':memory:')
migrate(routeDb)
routeDb.exec(`
  INSERT INTO users (id, username, spell_hash, role, created_at, updated_at) VALUES
    ('user-1', 'ana', 'hash-ana', 'owner', '2026-01-01', '2026-01-01'),
    ('user-3', 'cy', 'hash-cy', 'magician', '2026-01-03', '2026-01-03');
  INSERT INTO drives (id, user_id, provider, name, root_id, config_enc, granted_scope, created_at, updated_at) VALUES
    ('drive-1', 'user-1', 's3', 'Ana''s bucket', 'root', 'encrypted', '', '2026-01-01', '2026-01-01'),
    ('drive-3', 'user-3', 's3', 'Cy''s bucket', 'root', 'encrypted', '', '2026-01-03', '2026-01-03');
  INSERT INTO pool_folders (id, path, name, parent_path, created_by, created_at)
  VALUES ('pool-1', '/Shared', 'Shared', '/', 'user-3', '2026-01-04');
  INSERT INTO pool_folder_drives (folder_id, drive_id, created_at) VALUES
    ('pool-1', 'drive-1', '2026-01-04'),
    ('pool-1', 'drive-3', '2026-01-04');
`)

const bindings = testBindings(routeDb, { MAGICIAN_USERS: 'cy' })

const ownerToken = await createSession(bindings, { userId: 'user-1', driveId: 'drive-1', username: 'ana' })
const magicianToken = await createSession(bindings, { userId: 'user-3', driveId: 'drive-3', username: 'cy', role: 'magician' })

interface FilesPayload {
  data: { items: { name: string }[]; capabilities: string[]; canWrite: boolean }
}
const listing = async (init?: RequestInit) =>
  (await (await app.request('http://localhost/api/files?drive=global&path=/', init, bindings)).json()) as FilesPayload

// Anyone may browse the pool; nobody but a magician may change it.
const anonymous = await listing()
assert.deepEqual(anonymous.data.items.map(item => item.name), ['Shared'])
assert.equal(anonymous.data.canWrite, false)
assert.equal(anonymous.data.capabilities.includes('mkdir'), false)

const asOwner = await listing(identify(ownerToken))
assert.equal(asOwner.data.canWrite, false)
assert.equal(asOwner.data.capabilities.includes('mkdir'), false)

// At the root a magician conjures folders; files need one of those folders first.
const asMagician = await listing(identify(magicianToken))
assert.equal(asMagician.data.canWrite, true)
assert.equal(asMagician.data.capabilities.includes('mkdir'), true)
assert.equal(asMagician.data.capabilities.includes('upload'), false)

// Inside a conjured folder the full set applies, and unreachable providers degrade
// to an empty folder rather than an error.
const inside = await (await app.request(
  'http://localhost/api/files?drive=global&path=/Shared',
  identify(magicianToken),
  bindings,
)).json() as FilesPayload
assert.deepEqual(inside.data.items, [])
for (const capability of ['mkdir', 'upload', 'delete', 'rename']) {
  assert.equal(inside.data.capabilities.includes(capability), true, `magician should have ${capability} in a pooled folder`)
}

const mkdir = (body: unknown, init?: RequestInit) => app.request(
  'http://localhost/api/files/mkdir?drive=global',
  { method: 'POST', headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }, body: JSON.stringify(body) },
  bindings,
)

assert.equal((await mkdir({ path: '/', name: 'Reports' })).status, 401)
const refusedOwner = await mkdir({ path: '/', name: 'Reports' }, identify(ownerToken))
assert.equal(refusedOwner.status, 403)
assert.match((await refusedOwner.json() as { error: string }).error, /only a magician can create folders/)

// Even a magician cannot reach into a contributor's own subtree from the pool.
const refusedSubtree = await mkdir({ path: "/Ana's bucket", name: 'Reports' }, identify(magicianToken))
assert.equal(refusedSubtree.status, 403)
assert.match((await refusedSubtree.json() as { error: string }).error, new RegExp(POOL_NAME))

const refusedDelete = await app.request(
  `http://localhost/api/files/${encodeAggregateId('drive-1', 'file-9')}?drive=global`,
  { method: 'DELETE', ...identify(magicianToken) },
  bindings,
)
assert.equal(refusedDelete.status, 403)
assert.match((await refusedDelete.json() as { error: string }).error, /Switch to that storage/)

const invalidName = await mkdir({ path: '/', name: '..' }, identify(magicianToken))
assert.equal(invalidName.status, 400)

const drivesList = await (await app.request('http://localhost/api/drives', undefined, bindings)).json() as {
  data: { items: { id: string; name: string; is_virtual: boolean }[] }
}
assert.equal(drivesList.data.items[0].id, 'global')
assert.equal(drivesList.data.items[0].name, POOL_NAME)
assert.equal(drivesList.data.items[0].is_virtual, true)

// A pooled share keeps both identities: the virtual view reconstructs its
// branded id, while the physical drive keeps ownership and cascade semantics.
const pooledBytes = new TextEncoder().encode('pooled share')
const uploaded = await app.request(
  'http://localhost/api/files/upload?drive=global&path=/Shared&name=pooled.txt',
  {
    method: 'POST',
    headers: {
      ...(identify(magicianToken).headers as Record<string, string>),
      'Content-Type': 'text/plain',
      'Content-Length': String(pooledBytes.byteLength),
    },
    body: pooledBytes,
  },
  bindings,
)
assert.equal(uploaded.status, 201)
const pooledFile = await payload<{ id: string; name: string }>(uploaded)
memoryStores.get('drive-1')!.set(
  `${poolProviderPath('drive-1', '/Shared').slice(1)}/notes.txt`,
  { bytes: new Uint8Array(1), contentType: 'text/plain' },
)
const renameCollision = await app.request(
  `http://localhost/api/files/${encodeURIComponent(pooledFile.id)}?drive=global`,
  {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...identify(magicianToken).headers as Record<string, string> },
    body: JSON.stringify({ name: 'notes.txt', path: '/Shared' }),
  },
  bindings,
)
assert.equal(renameCollision.status, 409)
const createdShare = await app.request(
  'http://localhost/api/shares',
  {
    method: 'POST',
    headers: {
      ...(identify(magicianToken).headers as Record<string, string>),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fileId: pooledFile.id, name: pooledFile.name, driveId: 'global' }),
  },
  bindings,
)
assert.equal(createdShare.status, 201)
const pooledShare = await payload<{ id: string; url: string }>(createdShare)
const pooledTarget = decodeAggregateId(pooledFile.id).driveId.replace(/^pool:/, '')
const pooledShareRow = routeDb.prepare(
  'SELECT drive_id, virtual_drive_id FROM shares WHERE id = ?'
).get(pooledShare.id) as { drive_id: string | null; virtual_drive_id: string | null }
assert.equal(pooledShareRow.drive_id, pooledTarget)
assert.equal(pooledShareRow.virtual_drive_id, 'global')
const shared = await app.request(`http://localhost${pooledShare.url}`, undefined, bindings)
assert.equal(shared.status, 200)
assert.deepEqual(new Uint8Array(await shared.arrayBuffer()), pooledBytes)

// A later connection with a coincidentally named private folder is not a pool
// member and must survive pooled-folder deletion.
const lateDrive = connection('drive-late', 'Late bucket')
lateDrive.user_id = 'user-1'
routeDb.exec(`
  INSERT INTO drives (id, user_id, provider, name, root_id, config_enc, granted_scope, created_at, updated_at)
  VALUES ('drive-late', 'user-1', 's3', 'Late bucket', 'root', 'encrypted', '', '2026-01-05', '2026-01-05');
`)
const lateDriver = new MemoryDriver(lateDrive)
await lateDriver.mkdir('/', 'Shared')
await lateDriver.upload('/Shared', 'private.txt', new TextEncoder().encode('private').buffer as ArrayBuffer, 'text/plain')
const latePoolListing = await (await app.request(
  'http://localhost/api/files?drive=global&path=/Shared', undefined, bindings,
)).json() as { data: { items: { name: string }[] } }
assert.equal(latePoolListing.data.items.some(item => item.name === 'private.txt'), false)
const dispelled = await app.request(
  `http://localhost/api/files/${encodePoolId('/Shared')}?drive=global`,
  { method: 'DELETE', ...identify(magicianToken) },
  bindings,
)
assert.equal(dispelled.status, 200)
assert.equal((await lateDriver.list('/Shared')).items.some(item => item.name === 'private.txt'), true)

// A failed provider write must release its temporary placement reservation.
const reservationStore = new Map<string, string>()
routeDb.exec(`
  INSERT INTO pool_folders (id, path, name, parent_path, created_by, created_at)
  VALUES ('pool-reserve', '/Reserve', 'Reserve', '/', 'user-3', '2026-01-06');
  INSERT INTO pool_folder_drives (folder_id, drive_id, created_at)
  VALUES ('pool-reserve', 'drive-1', '2026-01-06');
`)
const reservationBindings = testBindings(routeDb, {
  SESSIONS: {
    get: async (key: string) => reservationStore.get(key) ?? null,
    put: async (key: string, value: string) => void reservationStore.set(key, value),
    delete: async (key: string) => void reservationStore.delete(key),
  } as never,
})
const reservationPool = new AggregateDriver(
  reservationBindings,
  [connection('drive-1', 'Ana bucket')],
  [conjured('Reserve')],
  { userId: 'user-3', isMagician: true },
)
memoryUploadFailing.add('drive-1')
await assert.rejects(reservationPool.upload('/Reserve', 'reservation.bin', new ArrayBuffer(1), 'application/octet-stream', 1))
memoryUploadFailing.delete('drive-1')
assert.equal(reservationStore.has('resv:drive-1'), false)

// A pending provider deletion blocks path reuse until the retry settles; this
// closes the race where cleanup could delete a freshly recreated folder.
routeDb.exec(`
  INSERT INTO pool_deletions (id, drive_id, parent_path, name, attempts, created_at)
  VALUES ('pending-recreate', 'drive-1', '/', 'Pending', 0, '2026-01-06');
`)
const blockedRecreate = await mkdir({ path: '/', name: 'Pending' }, identify(magicianToken))
assert.equal(blockedRecreate.status, 409)
assert.equal(routeDb.prepare("SELECT 1 FROM pool_folders WHERE path = '/Pending'").get(), undefined)

// The role is read from the database, not from whatever the session was minted with.
const me = await (await app.request('http://localhost/api/auth/me', identify(ownerToken), bindings)).json() as {
  data: { user: { role?: string } }
}
assert.equal(me.data.user.role, 'owner')
routeDb.close()

console.log('pooled storage and magician role checks passed')
