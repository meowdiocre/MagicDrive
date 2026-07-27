import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { app } from '../src/worker/index'
import { createSession } from '../src/worker/auth/session'
import { parseRange } from '../src/worker/drivers/vault'
import { decryptSegment, encryptSegment, generateWrappedKey, unwrapKey } from '../src/worker/lib/vault-crypto'
import { cleanupExpiredUploads } from '../src/worker/lib/vault'
import { poolProviderPath, retryPoolDeletions } from '../src/worker/lib/pool'
import { reservedBytes } from '../src/worker/lib/placement'
import { invalidateStatus } from '../src/worker/lib/status'
import {
  errorOf, identify, memoryFailing, memoryQuota, memoryStores, memoryUploadFailing, migrate, payload,
  registerMemoryProvider, testBindings,
} from './harness'

// --- Segment crypto ---------------------------------------------------------------

const wrapped = await generateWrappedKey('secret')
const key = await unwrapKey('secret', wrapped)
const plain = crypto.getRandomValues(new Uint8Array(1024)).buffer as ArrayBuffer

const sealed = await encryptSegment(key, 'obj-1', 3, plain)
assert.equal(sealed.cipher.byteLength, 1024 + 12 + 16, 'iv + tag overhead')
assert.match(sealed.sha256, /^[0-9a-f]{64}$/)
assert.deepEqual(new Uint8Array(await decryptSegment(key, 'obj-1', 3, sealed.cipher.buffer as ArrayBuffer)), new Uint8Array(plain))

// A segment refuses to open in another file, another slot, or under another key.
await assert.rejects(decryptSegment(key, 'obj-2', 3, sealed.cipher.buffer as ArrayBuffer))
await assert.rejects(decryptSegment(key, 'obj-1', 4, sealed.cipher.buffer as ArrayBuffer))
await assert.rejects(decryptSegment(await unwrapKey('secret', await generateWrappedKey('secret')), 'obj-1', 3, sealed.cipher.buffer as ArrayBuffer))
const flipped = sealed.cipher.slice()
flipped[100] ^= 0xff
await assert.rejects(decryptSegment(key, 'obj-1', 3, flipped.buffer as ArrayBuffer))

// --- Range math -------------------------------------------------------------------

assert.deepEqual(parseRange('bytes=0-99', 1000), [0, 99])
assert.deepEqual(parseRange('bytes=500-', 1000), [500, 999])
assert.deepEqual(parseRange('bytes=-100', 1000), [900, 999])
assert.deepEqual(parseRange('bytes=0-5000', 1000), [0, 999])
assert.equal(parseRange(null, 1000), null)
assert.equal(parseRange('bytes=-', 1000), null)
assert.throws(() => parseRange('bytes=1000-', 1000), /not satisfiable/)

// --- The full lifecycle over memory vaults ------------------------------------------

registerMemoryProvider()
const db = new DatabaseSync(':memory:')
migrate(db)
db.exec(`
  INSERT INTO users (id, username, spell_hash, role, created_at, updated_at) VALUES
    ('user-1', 'ana', 'hash-ana', 'owner', '2026-01-01', '2026-01-01'),
    ('user-2', 'ben', 'hash-ben', 'owner', '2026-01-02', '2026-01-02'),
    ('user-3', 'cara', 'hash-cara', 'owner', '2026-01-03', '2026-01-03');
  INSERT INTO drives (id, user_id, provider, name, root_id, config_enc, granted_scope, created_at, updated_at) VALUES
    ('vault-a', 'user-1', 's3', 'Ana A', 'root', 'enc', '', '2026-01-01', '2026-01-01'),
    ('vault-b', 'user-1', 's3', 'Ana B', 'root', 'enc', '', '2026-01-01', '2026-01-01'),
    ('vault-ben', 'user-2', 's3', 'Ben', 'root', 'enc', '', '2026-01-02', '2026-01-02'),
    ('vault-cara-a', 'user-3', 's3', 'Cara A', 'root', 'enc', '', '2026-01-03', '2026-01-03'),
    ('vault-cara-b', 'user-3', 's3', 'Cara B', 'root', 'enc', '', '2026-01-03', '2026-01-03');
`)
// Tiny segments so a multi-segment file stays cheap to build.
const bindings = testBindings(db, { VAULT_SEGMENT_SIZE: '1024' })
const ana = await createSession(bindings, { userId: 'user-1', driveId: '', username: 'ana' })
const ben = await createSession(bindings, { userId: 'user-2', driveId: '', username: 'ben' })
const cara = await createSession(bindings, { userId: 'user-3', driveId: '', username: 'cara' })

const json = (method: string, url: string, body: unknown, token?: string) => app.request(
  url,
  {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? identify(token).headers as Record<string, string> : {}) },
    body: JSON.stringify(body),
  },
  bindings,
)

// The vault appears as a virtual drive once any storage is connected.
const drivesList = await payload<{ items: { id: string; provider: string }[] }>(
  await app.request('http://localhost/api/drives', undefined, bindings),
)
assert.ok(drivesList.items.some(item => item.id === 'vault' && item.provider === 'vault'))

// Folders are D1 rows; anonymous visitors browse but never write.
assert.equal((await json('POST', 'http://localhost/api/files/mkdir?drive=vault', { path: '/', name: 'Books' })).status, 401)
assert.equal((await json('POST', 'http://localhost/api/files/mkdir?drive=vault', { path: '/', name: 'Books' }, ana)).status, 201)
assert.equal((await json('POST', 'http://localhost/api/files/mkdir?drive=vault', { path: '/', name: 'books' }, ana)).status, 409)
assert.equal((await json('POST', 'http://localhost/api/files/mkdir?drive=vault', { path: '/Nope', name: 'x' }, ana)).status, 404)

// A 2.5-segment file goes up in pieces and lands striped across Ana's two vaults.
const SIZE = 1024 * 2 + 512
const content = crypto.getRandomValues(new Uint8Array(SIZE))
const session = await payload<{ id: string; segmentSize: number; segmentCount: number }>(
  await json('POST', 'http://localhost/api/vault/uploads', {
    path: '/Books', name: 'grimoire.bin', size: SIZE, contentType: 'application/x-grimoire',
  }, ana),
)
assert.equal(session.segmentSize, 1024)
assert.equal(session.segmentCount, 3)

// Ben cannot push pieces into Ana's session.
const putSegment = (idx: number, bytes: Uint8Array, token: string) => app.request(
  `http://localhost/api/vault/uploads/${session.id}/segments/${idx}`,
  { method: 'PUT', headers: identify(token).headers as Record<string, string>, body: bytes.slice().buffer as ArrayBuffer },
  bindings,
)
assert.equal((await putSegment(0, content.slice(0, 1024), ben)).status, 403)

// Committing early names what is missing.
const early = await json('POST', `http://localhost/api/vault/uploads/${session.id}/commit`, {}, ana)
assert.equal(early.status, 409)
assert.match(await errorOf(early), /missing segment/i)

assert.equal((await putSegment(0, content.slice(0, 1024), ana)).status, 200)
assert.equal((await putSegment(1, content.slice(1024, 2048), ana)).status, 200)
assert.equal((await putSegment(2, content.slice(2048), ana)).status, 200)
assert.equal((await putSegment(3, content.slice(0, 1024), ana)).status, 400)
// Wrong-sized pieces are refused before they touch a vault.
assert.equal((await putSegment(1, content.slice(0, 100), ana)).status, 400)
assert.equal((await json('POST', `http://localhost/api/vault/uploads/${session.id}/commit`, {}, ana)).status, 200)

// Account deletion must not cascade the drive credentials needed to reconstruct
// committed MagicVault data.
assert.throws(
  () => db.exec("DELETE FROM users WHERE id = 'user-1'"),
  /Cannot delete a user while they own MagicVault objects/,
)
assert.equal((db.prepare("SELECT COUNT(*) AS count FROM users WHERE id = 'user-1'").get() as { count: number }).count, 1)

// Striped across Ana's vaults only: Ben's vault holds nothing of it.
const segmentHomes = (db.prepare('SELECT DISTINCT drive_id FROM vault_segments').all() as { drive_id: string }[]).map(row => row.drive_id)
assert.ok(segmentHomes.every(home => home === 'vault-a' || home === 'vault-b'))
assert.equal(memoryStores.get('vault-ben')?.size ?? 0, 0)
// The README landed next to the first piece on each vault used.
for (const home of new Set(segmentHomes)) {
  assert.ok(memoryStores.get(home)?.has('MagicVault/README.txt'), `${home} should hold the README`)
}

// A member cannot plant anything in another member's folder: that would lock it,
// since only the object's owner can remove it and folders refuse to delete full.
assert.equal((await json('POST', 'http://localhost/api/files/mkdir?drive=vault', { path: '/Books', name: 'sneak' }, ben)).status, 403)
assert.equal(
  (await json('POST', 'http://localhost/api/vault/uploads', { path: '/Books', name: 'sneak.bin', size: 10 }, ben)).status,
  403,
)

// The file lists, downloads whole, and honors ranges, all anonymously.
const listing = await payload<{ items: { id: string; name: string; size: number }[] }>(
  await app.request('http://localhost/api/files?drive=vault&path=/Books', undefined, bindings),
)
const fileId = listing.items.find(item => item.name === 'grimoire.bin')!.id
assert.equal(listing.items.find(item => item.name === 'grimoire.bin')!.size, SIZE)

const whole = await app.request(`http://localhost/api/files/${fileId}/download?drive=vault`, undefined, bindings)
assert.equal(whole.status, 200)
assert.equal(whole.headers.get('Content-Length'), String(SIZE))
assert.deepEqual(new Uint8Array(await whole.arrayBuffer()), content)

const range = await app.request(
  `http://localhost/api/files/${fileId}/download?drive=vault`,
  { headers: { Range: 'bytes=1000-2100' } },
  bindings,
)
assert.equal(range.status, 206)
assert.equal(range.headers.get('Content-Range'), `bytes 1000-2100/${SIZE}`)
assert.deepEqual(new Uint8Array(await range.arrayBuffer()), content.slice(1000, 2101))

// MagicVault is virtual and has no drives row. Its share keeps that routing
// identity and reconstructs the encrypted pieces for an anonymous visitor.
const createdShare = await json('POST', 'http://localhost/api/shares', {
  fileId, name: 'grimoire.bin', driveId: 'vault',
}, ana)
assert.equal(createdShare.status, 201)
const share = await payload<{ id: string; url: string }>(createdShare)
const shareRow = db.prepare('SELECT drive_id, virtual_drive_id FROM shares WHERE id = ?').get(share.id) as {
  drive_id: string | null; virtual_drive_id: string | null
}
assert.equal(shareRow.drive_id, null)
assert.equal(shareRow.virtual_drive_id, 'vault')
const shares = await payload<{ items: { id: string; drive_name: string }[] }>(
  await app.request('http://localhost/api/shares', identify(ana), bindings),
)
assert.equal(shares.items.find(item => item.id === share.id)?.drive_name, 'MagicVault')
const shared = await app.request(`http://localhost${share.url}`, undefined, bindings)
assert.equal(shared.status, 200)
assert.deepEqual(new Uint8Array(await shared.arrayBuffer()), content)

// Tampered ciphertext fails closed instead of serving garbage.
const tamperedRow = db.prepare('SELECT drive_id, provider_ref FROM vault_segments WHERE idx = 1').get() as { drive_id: string; provider_ref: string }
const tamperedKey = Buffer.from(tamperedRow.provider_ref.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8')
const store = memoryStores.get(tamperedRow.drive_id)!
const held = store.get(tamperedKey)!
const corrupted = held.bytes.slice()
corrupted[50] ^= 0xff
store.set(tamperedKey, { ...held, bytes: corrupted })
const poisoned = await app.request(`http://localhost/api/files/${fileId}/download?drive=vault`, undefined, bindings)
const leaked = await poisoned.arrayBuffer().catch(() => null)
assert.ok(leaked === null || leaked.byteLength < SIZE, 'a corrupted segment must not decrypt to full content')
store.set(tamperedKey, held)

// Renames and deletes are the owner's alone; folder renames carry the subtree.
assert.equal((await json('PATCH', `http://localhost/api/files/${fileId}?drive=vault`, { name: 'tome.bin' }, ben)).status, 403)
assert.equal((await json('PATCH', `http://localhost/api/files/${fileId}?drive=vault`, { name: 'tome.bin' }, ana)).status, 200)
const booksId = (db.prepare("SELECT id FROM vault_objects WHERE path = '/Books'").get() as { id: string }).id
assert.equal((await json('PATCH', `http://localhost/api/files/${booksId}?drive=vault`, { name: 'Library' }, ana)).status, 200)
assert.equal(
  (db.prepare("SELECT path FROM vault_objects WHERE name = 'tome.bin'").get() as { path: string }).path,
  '/Library/tome.bin',
)

// A folder with contents refuses deletion; the file deletes and takes its pieces along.
const removeAs = (id: string, token: string) => app.request(
  `http://localhost/api/files/${id}?drive=vault`,
  { method: 'DELETE', ...identify(token) },
  bindings,
)
assert.equal((await removeAs(booksId, ana)).status, 409)
assert.equal((await removeAs(fileId, ben)).status, 403)
assert.equal((await removeAs(fileId, ana)).status, 200)
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM vault_segments').get()!.count, 0)
for (const home of ['vault-a', 'vault-b']) {
  const keys = [...(memoryStores.get(home)?.keys() ?? [])]
  // The MagicVault/objects scaffolding may remain; object folders must not.
  assert.ok(!keys.some(k => /MagicVault\/objects\/./.test(k)), `${home} should hold no orphaned pieces`)
}
assert.equal((await removeAs(booksId, ana)).status, 200)

// --- Sweeps -----------------------------------------------------------------------

// An abandoned session expires and its stored pieces vanish from the vaults.
const stale = await payload<{ id: string }>(
  await json('POST', 'http://localhost/api/vault/uploads', { path: '/', name: 'stale.bin', size: 2048 }, ana),
)
await putSegment2(stale.id, 0, content.slice(0, 1024), ana)
db.prepare("UPDATE vault_objects SET expires_at = '2020-01-01' WHERE id = ?").run(stale.id)
assert.equal(await cleanupExpiredUploads(bindings as never), 1)
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM vault_objects').get()!.count, 0)

async function putSegment2(id: string, idx: number, bytes: Uint8Array, token: string) {
  return app.request(
    `http://localhost/api/vault/uploads/${id}/segments/${idx}`,
    { method: 'PUT', headers: identify(token).headers as Record<string, string>, body: bytes.slice().buffer as ArrayBuffer },
    bindings,
  )
}

// A pooled deletion that failed on one connection is journaled, then retried.
db.exec(`
  INSERT INTO pool_deletions (id, drive_id, parent_path, name, attempts, created_at)
  VALUES ('pd-1', 'vault-a', '/', 'OldFolder', 0, '2026-01-01')
`)
const oldFolderKey = poolProviderPath('vault-a', '/OldFolder').slice(1)
memoryStores.get('vault-a')!.set(`${oldFolderKey}/junk.txt`, { bytes: new Uint8Array(4), contentType: 'text/plain' })
memoryFailing.add('vault-a')
assert.equal(await retryPoolDeletions(bindings as never), 0)
assert.equal(db.prepare("SELECT attempts FROM pool_deletions WHERE id = 'pd-1'").get()!.attempts, 1)
memoryFailing.delete('vault-a')
assert.equal(await retryPoolDeletions(bindings as never), 1)
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pool_deletions').get()!.count, 0)
assert.ok(![...memoryStores.get('vault-a')!.keys()].some(k => k.startsWith(`${oldFolderKey}/`)))

// Quota-aware striping: with one vault nearly full, pieces avoid it.
memoryQuota.set('vault-a', 300 * 1024 * 1024)
memoryQuota.set('vault-b', 5 * 1024 * 1024 * 1024)
await invalidateStatus(bindings as never, 'vault-a')
await invalidateStatus(bindings as never, 'vault-b')
const placedSession = await payload<{ id: string; segmentCount: number }>(
  await json('POST', 'http://localhost/api/vault/uploads', { path: '/', name: 'placed.bin', size: 2048 }, ana),
)
await putSegment2(placedSession.id, 0, content.slice(0, 1024), ana)
await putSegment2(placedSession.id, 1, content.slice(1024, 2048), ana)
assert.equal((await json('POST', `http://localhost/api/vault/uploads/${placedSession.id}/commit`, {}, ana)).status, 200)
const placedHomes = db.prepare('SELECT DISTINCT drive_id FROM vault_segments WHERE object_id = ?').all(placedSession.id) as { drive_id: string }[]
assert.deepEqual(placedHomes.map(row => row.drive_id), ['vault-b'])

// A retried segment must not destroy the ciphertext it just wrote: on
// key-addressed providers the replacement used to land on the previous key.
const retry = await payload<{ id: string; segmentCount: number }>(
  await json('POST', 'http://localhost/api/vault/uploads', { path: '/', name: 'retried.bin', size: 1536 }, ana),
)
await putSegment2(retry.id, 0, content.slice(0, 1024), ana)
await putSegment2(retry.id, 0, content.slice(0, 1024), ana)
await putSegment2(retry.id, 1, content.slice(1024, 1536), ana)
await putSegment2(retry.id, 1, content.slice(1024, 1536), ana)
assert.equal((await json('POST', `http://localhost/api/vault/uploads/${retry.id}/commit`, {}, ana)).status, 200)
const retried = await app.request(`http://localhost/api/files/${retry.id}/download?drive=vault`, undefined, bindings)
assert.equal(retried.status, 200)
assert.deepEqual(new Uint8Array(await retried.arrayBuffer()), content.slice(0, 1536))

// Providers without quota reporting still distribute pieces by committed load.
memoryQuota.delete('vault-a')
memoryQuota.delete('vault-b')
await invalidateStatus(bindings as never, 'vault-a')
await invalidateStatus(bindings as never, 'vault-b')
const unknownQuotaContent = crypto.getRandomValues(new Uint8Array(4096))
const unknownQuota = await payload<{ id: string }>(
  await json('POST', 'http://localhost/api/vault/uploads', { path: '/', name: 'unknown-quota.bin', size: unknownQuotaContent.byteLength }, cara),
)
for (let idx = 0; idx < 4; idx += 1) {
  await putSegment2(unknownQuota.id, idx, unknownQuotaContent.slice(idx * 1024, (idx + 1) * 1024), cara)
}
assert.equal((await json('POST', `http://localhost/api/vault/uploads/${unknownQuota.id}/commit`, {}, cara)).status, 200)
const unknownHomes = db.prepare('SELECT DISTINCT drive_id FROM vault_segments WHERE object_id = ?').all(unknownQuota.id) as { drive_id: string }[]
assert.ok(unknownHomes.length > 1, 'unknown quotas must not pin every segment to the first vault')

// A rejected provider write releases its placement reservation immediately.
const rejected = await payload<{ id: string }>(
  await json('POST', 'http://localhost/api/vault/uploads', { path: '/', name: 'rejected.bin', size: 512 }, ana),
)
memoryUploadFailing.add('vault-a')
memoryUploadFailing.add('vault-b')
const originalError = console.error
console.error = () => {}
let rejectedResponse: Response
try {
  rejectedResponse = await putSegment2(rejected.id, 0, content.slice(0, 512), ana)
} finally {
  console.error = originalError
}
assert.equal(rejectedResponse!.status, 500)
memoryUploadFailing.clear()
assert.equal(await reservedBytes(bindings as never, 'vault-a'), 0)
assert.equal(await reservedBytes(bindings as never, 'vault-b'), 0)

// Disconnecting a vault that still holds pieces would orphan those files.
const holder = (db.prepare('SELECT DISTINCT drive_id FROM vault_segments').get() as { drive_id: string }).drive_id
const refusedDelete = await app.request(
  `http://localhost/api/drives/${holder}`,
  { method: 'DELETE', ...identify(ana) },
  bindings,
)
assert.equal(refusedDelete.status, 409)
assert.match(await errorOf(refusedDelete), /MagicVault/)

// An expired session is refused rather than left for whenever the sweep runs.
const expiring = await payload<{ id: string }>(
  await json('POST', 'http://localhost/api/vault/uploads', { path: '/', name: 'expired.bin', size: 512 }, ana),
)
db.prepare("UPDATE vault_objects SET expires_at = '2020-01-01' WHERE id = ?").run(expiring.id)
assert.equal((await putSegment2(expiring.id, 0, content.slice(0, 512), ana)).status, 410)
assert.equal((await json('POST', `http://localhost/api/vault/uploads/${expiring.id}/commit`, {}, ana)).status, 410)

db.close()
console.log('MagicVault checks passed')
