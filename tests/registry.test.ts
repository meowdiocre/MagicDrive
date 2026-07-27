import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { app } from '../src/worker/index'
import { PROVIDERS, providerById, validateConfig } from '../src/worker/drivers/registry'
import { multipartRelatedBody } from '../src/worker/drivers/google'
import { createSession } from '../src/worker/auth/session'
import { encodeAggregateId } from '../src/worker/drivers/aggregate'
import { encodeBase64UrlUtf8 } from '../src/worker/lib/base64'
import { poolProviderPath } from '../src/worker/lib/pool'
import { invalidateStatus, withTimeout } from '../src/worker/lib/status'
import { pickPlacement, RESERVE_BYTES } from '../src/worker/lib/placement'
import {
  errorOf, identify, memoryFailing, memoryPageSize, memoryQuota, memoryStores, migrate, payload,
  registerMemoryProvider, testBindings,
} from './harness'

// --- Registry definitions -----------------------------------------------------

const ids = PROVIDERS.map(entry => entry.id)
assert.equal(new Set(ids).size, ids.length, 'provider ids must be unique')
for (const definition of PROVIDERS) {
  assert.ok(['google', 'webdav', 's3'].includes(definition.base), definition.id)
  if (definition.auth === 'config') {
    assert.ok(definition.fields.length > 0, `${definition.id} needs fields`)
  }
}
// Presets must ask for the same keys their base validates.
const REQUIRED: Record<'webdav' | 's3', string[]> = {
  webdav: ['url', 'username', 'password'],
  s3: ['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'],
}
for (const definition of PROVIDERS.filter(entry => entry.auth === 'config')) {
  const keys = definition.fields.map(field => field.key)
  assert.deepEqual(keys, REQUIRED[definition.base as 'webdav' | 's3'], definition.id)
}

assert.equal(providerById('r2')?.base, 's3')
assert.equal(providerById('nope'), undefined)
await assert.rejects(withTimeout(new Promise<never>(() => {}), 5), /timed out/)
assert.equal(
  await new Response(multipartRelatedBody(
    new TextEncoder().encode('head:'),
    new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('file')); controller.close() } }),
    new TextEncoder().encode(':tail'),
  )).text(),
  'head:file:tail',
)
assert.match((validateConfig('webdav', { url: 'http://insecure', username: 'u', password: 'p' }) as { error: string }).error, /HTTPS/)
assert.ok('ok' in validateConfig('s3', {
  endpoint: 'https://s3.example.com', region: 'auto', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's',
}))

// --- Routes over the registry ---------------------------------------------------

registerMemoryProvider()

const db = new DatabaseSync(':memory:')
migrate(db)
db.exec(`
  INSERT INTO users (id, username, spell_hash, role, created_at, updated_at) VALUES
    ('user-1', 'ana', 'hash-ana', 'owner', '2026-01-01', '2026-01-01'),
    ('user-3', 'cyrus', 'hash-cy', 'magician', '2026-01-03', '2026-01-03');
`)
const bindings = testBindings(db, { MAGICIAN_USERS: 'cyrus' })
const anaToken = await createSession(bindings, { userId: 'user-1', driveId: '', username: 'ana' })

const providersList = await payload<{ id: string; auth: string }[]>(
  await app.request('http://localhost/api/providers', undefined, bindings),
)
assert.ok(providersList.some(entry => entry.id === 'r2'))
assert.ok(providersList.some(entry => entry.id === 'nextcloud'))

// Without Google secrets the OAuth entry disappears but config providers stay.
const bare = await payload<{ id: string }[]>(
  await app.request('http://localhost/api/providers', undefined, testBindings(db, { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' })),
)
assert.ok(!bare.some(entry => entry.id === 'google'))
assert.ok(bare.some(entry => entry.id === 's3'))

// Connecting through a preset stores the base provider id.
const addDrive = (body: unknown) => app.request(
  'http://localhost/api/drives',
  { method: 'POST', headers: { 'Content-Type': 'application/json', ...identify(anaToken).headers as Record<string, string> }, body: JSON.stringify(body) },
  bindings,
)
const viaPreset = await addDrive({
  provider: 'r2', name: 'Ana R2',
  config: { endpoint: 'https://acc.r2.cloudflarestorage.com', region: 'auto', bucket: 'pool', accessKeyId: 'k', secretAccessKey: 's' },
})
assert.equal(viaPreset.status, 201)
const presetData = await payload<{ provider: string; provider_variant: string }>(viaPreset)
assert.equal(presetData.provider, 's3')
assert.equal(presetData.provider_variant, 'r2')
assert.equal(
  (db.prepare("SELECT provider FROM drives WHERE name = 'Ana R2'").get() as { provider: string }).provider,
  's3',
)
assert.equal(
  (db.prepare("SELECT provider_variant FROM drives WHERE name = 'Ana R2'").get() as { provider_variant: string }).provider_variant,
  'r2',
)

assert.equal((await addDrive({ provider: 'google', name: 'x', config: {} })).status, 400)
assert.equal((await addDrive({ provider: 'unknown', name: 'x', config: {} })).status, 400)
const badPreset = await addDrive({ provider: 'nextcloud', name: 'NC', config: { url: 'http://nope', username: 'u', password: 'p' } })
assert.equal(badPreset.status, 400)
assert.match(await errorOf(badPreset), /HTTPS/)

// --- Instant magician revocation -------------------------------------------------

const cyToken = await createSession(bindings, { userId: 'user-3', driveId: '', username: 'cyrus', role: 'magician' })
// Same DB and session store, different env: only the grant list changes.
const withVars = (vars: Record<string, string>) => ({ ...bindings as object, ...vars }) as never
const mkdirPool = (vars: Record<string, string>) => app.request(
  'http://localhost/api/files/mkdir?drive=global',
  { method: 'POST', headers: { 'Content-Type': 'application/json', ...identify(cyToken).headers as Record<string, string> }, body: JSON.stringify({ path: '/', name: 'Shared' }) },
  withVars(vars),
)
// The DB row still says magician, but the env no longer does: refused at once.
assert.equal((await mkdirPool({ MAGICIAN_USERS: '' })).status, 403)
const meRevoked = await payload<{ user: { role: string } }>(
  await app.request('http://localhost/api/auth/me', identify(cyToken), withVars({ MAGICIAN_USERS: '' })),
)
assert.equal(meRevoked.user.role, 'owner')
// And granted in env without any sign-in: allowed at once.
assert.equal((await mkdirPool({ MAGICIAN_USERS: 'cyrus' })).status, 201)

// --- Pooled upload collision -----------------------------------------------------

// The mkdir above conjured /Shared on Ana's memory-backed drive.
const driveId = (db.prepare("SELECT id FROM drives WHERE name = 'Ana R2'").get() as { id: string }).id
const sharedKey = (id: string) => poolProviderPath(id, '/Shared').slice(1)
assert.ok(memoryStores.get(driveId)?.has(`${sharedKey(driveId)}/`))

const uploadPool = (name: string) => app.request(
  `http://localhost/api/files/upload?drive=global&path=/Shared&name=${encodeURIComponent(name)}`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain', 'Content-Length': '5',
      ...identify(cyToken).headers as Record<string, string>,
    },
    body: 'hello',
  },
  bindings,
)
assert.equal((await uploadPool('notes.txt')).status, 201)
assert.ok(memoryStores.get(driveId)?.has(`${sharedKey(driveId)}/notes.txt`))
const collision = await uploadPool('NOTES.txt')
assert.equal(collision.status, 409)
assert.match(await errorOf(collision), /already exists/)

// Deleting a pooled file goes through the pool id scheme, not the bare drive id.
const bare2 = await app.request(
  `http://localhost/api/files/${encodeAggregateId(driveId, 'x')}?drive=global`,
  { method: 'DELETE', ...identify(cyToken) },
  bindings,
)
assert.equal(bare2.status, 403)

// A contributor's own file, listed publicly through the pool, carries a bare
// drive id. Re-encoding it with the pool prefix must not turn it into a pooled
// file: the prefix is not a claim the client gets to make.
memoryStores.get(driveId)!.set('private/tax.pdf', { bytes: new Uint8Array(3), contentType: 'application/pdf' })
const forged = encodeAggregateId(`pool:${driveId}`, encodeBase64UrlUtf8('private/tax.pdf'))
for (const [method, body] of [['DELETE', undefined], ['PATCH', JSON.stringify({ name: 'pwned.pdf' })]] as const) {
  const response = await app.request(
    `http://localhost/api/files/${forged}?drive=global`,
    { method, headers: { 'Content-Type': 'application/json', ...identify(cyToken).headers as Record<string, string> }, body },
    bindings,
  )
  assert.equal(response.status, 403, `${method} with a forged pool id must be refused`)
}
assert.ok(memoryStores.get(driveId)!.has('private/tax.pdf'), "a contributor's own file survives a forged id")

// --- Usage and health ------------------------------------------------------------

memoryQuota.set(driveId, 1024)
// The pooled upload above already probed and cached this drive without a quota.
await invalidateStatus(bindings as never, driveId)
const publicDrives = await payload<{ items: Record<string, unknown>[] }>(
  await app.request('http://localhost/api/drives', undefined, bindings),
)
const publicAnaDrive = publicDrives.items.find(item => item.id === driveId)!
assert.ok(!('usage' in publicAnaDrive), 'public drive metadata must not reveal provider quota')
assert.ok(!('health' in publicAnaDrive), 'public drive metadata must not reveal provider errors')

const drivesWithUsage = await payload<{ items: { id: string; usage?: { usedBytes: number; totalBytes: number | null } | null; health?: { ok: boolean } }[] }>(
  await app.request('http://localhost/api/drives', identify(anaToken), bindings),
)
const anaDrive = drivesWithUsage.items.find(item => item.id === driveId)!
assert.equal(anaDrive.health?.ok, true)
assert.equal(anaDrive.usage?.totalBytes, 1024)
assert.ok(anaDrive.usage!.usedBytes > 0)
const globalItem = drivesWithUsage.items.find(item => item.id === 'global')!
assert.ok(!globalItem.usage, 'aggregate quota must not reveal other contributors capacity')

// The probe is cached: a now-unreachable provider still reports its last state.
memoryFailing.add(driveId)
const cachedStatus = await payload<{ items: { id: string; health: { ok: boolean } }[] }>(
  await app.request('http://localhost/api/drives', identify(anaToken), bindings),
)
assert.equal(cachedStatus.items.find(item => item.id === driveId)!.health.ok, true)

// With the cache dropped the failure surfaces.
await invalidateStatus(bindings as never, driveId)
const failedStatus = await payload<{ items: { id: string; health: { ok: boolean; message?: string }; usage: unknown }[] }>(
  await app.request('http://localhost/api/drives', identify(anaToken), bindings),
)
const failedDrive = failedStatus.items.find(item => item.id === driveId)!
assert.equal(failedDrive.health.ok, false)
assert.match(failedDrive.health.message ?? '', /unreachable/i)
memoryFailing.delete(driveId)
await invalidateStatus(bindings as never, driveId)

// --- Capacity-aware placement -----------------------------------------------------

const candidate = (entry: string, freeBytes: number | null, held = 0, healthy = true) =>
  ({ entry, freeBytes, healthy, held })
// Most proven free space wins.
assert.equal(pickPlacement([candidate('a', 10_000_000_000), candidate('b', 50_000_000_000)], 1000), 'b')
// A vault that cannot fit the file with headroom drops out.
assert.equal(pickPlacement([candidate('a', RESERVE_BYTES + 500), candidate('b', null, 3)], 1000), 'b')
// Unknown-capacity vaults tiebreak on how much they already hold.
assert.equal(pickPlacement([candidate('a', null, 9), candidate('b', null, 2)], 1000), 'b')
// Unhealthy vaults never win, and a pool with no fit reports none.
assert.equal(pickPlacement([candidate('a', 50_000_000_000, 0, false)], 1000), null)
assert.equal(pickPlacement([candidate('a', RESERVE_BYTES)], 1), null)
assert.equal(pickPlacement([], 1), null)

// Route level: with quotas known, the pooled upload lands on the roomier vault.
db.exec(`
  INSERT INTO drives (id, user_id, provider, name, root_id, config_enc, granted_scope, created_at, updated_at)
  VALUES ('drive-roomy', 'user-1', 's3', 'Roomy', 'root', 'enc', '', '2026-01-05', '2026-01-05');
  INSERT INTO pool_folder_drives (folder_id, drive_id, created_at)
  SELECT id, 'drive-roomy', '2026-01-05' FROM pool_folders WHERE path = '/Shared';
`)
memoryQuota.set(driveId, RESERVE_BYTES + 1_000_000)
memoryQuota.set('drive-roomy', RESERVE_BYTES + 900_000_000)
await invalidateStatus(bindings as never, driveId)
const placed = await uploadPool('placed.bin')
assert.equal(placed.status, 201)
assert.ok(memoryStores.get('drive-roomy')?.has(`${sharedKey('drive-roomy')}/placed.bin`), 'file should land on the roomier vault')
assert.ok(!memoryStores.get(driveId)?.has(`${sharedKey(driveId)}/placed.bin`))

// When nothing that reports capacity can fit the file, the pool refuses honestly.
memoryQuota.set('drive-roomy', RESERVE_BYTES + 1_000_000)
await invalidateStatus(bindings as never, 'drive-roomy')
await invalidateStatus(bindings as never, driveId)
const overfull = await app.request(
  'http://localhost/api/files/upload?drive=global&path=/Shared&name=big.bin',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream', 'Content-Length': String(2_000_000),
      ...identify(cyToken).headers as Record<string, string>,
    },
    body: new Uint8Array(64),
  },
  bindings,
)
assert.equal(overfull.status, 507)

// --- Pagination, casing, and adoption --------------------------------------------

// A name past the first provider page still counts as taken.
const store = memoryStores.get(driveId)!
for (let index = 0; index < 12; index += 1) store.set(`${sharedKey(driveId)}/pad-${index}.txt`, { bytes: new Uint8Array(1), contentType: 'text/plain' })
store.set(`${sharedKey(driveId)}/buried.txt`, { bytes: new Uint8Array(1), contentType: 'text/plain' })
memoryPageSize.set(driveId, 3)
memoryPageSize.set('drive-roomy', 3)
const buried = await uploadPool('BURIED.txt')
assert.equal(buried.status, 409, 'a name on a later page must still collide')
memoryPageSize.delete(driveId)
memoryPageSize.delete('drive-roomy')

// The pooled root matches case-insensitively, and the path handed to providers
// is rewritten to the casing the folder was conjured with.
const mixedCase = await payload<{ path: string; items: { name: string }[] }>(
  await app.request('http://localhost/api/files?drive=global&path=/shared', undefined, bindings),
)
assert.equal(mixedCase.path, '/Shared')
assert.ok(mixedCase.items.some(item => item.name === 'notes.txt'), 'the real folder contents must resolve')

// The pool is one namespace across pages too: the same name on two connections
// must not surface twice just because they paginate independently.
store.set(`${sharedKey(driveId)}/dupe.txt`, { bytes: new Uint8Array(1), contentType: 'text/plain' })
memoryStores.get('drive-roomy')!.set(`${sharedKey('drive-roomy')}/dupe.txt`, { bytes: new Uint8Array(2), contentType: 'text/plain' })
// Five per page over 15 items stays inside the four-page walk bound.
memoryPageSize.set(driveId, 5)
memoryPageSize.set('drive-roomy', 5)
const merged = await payload<{ items: { name: string }[]; nextPageToken: string | null; truncated?: boolean }>(
  await app.request('http://localhost/api/files?drive=global&path=/Shared', undefined, bindings),
)
const names = merged.items.map(item => item.name)
// Resolved in one response, with every connection's pages walked and merged.
assert.equal(merged.nextPageToken, null)
assert.equal(names.filter(name => name === 'dupe.txt').length, 1, 'a shared name must be claimed once')
assert.equal(new Set(names).size, names.length, 'the merged listing must not repeat a name')
assert.ok(names.includes('buried.txt'), 'items past the first page must still appear')
assert.notEqual(merged.truncated, true)

// Past the walk bound the shortfall is reported rather than passed off as the end.
memoryPageSize.set(driveId, 1)
const capped = await payload<{ truncated?: boolean }>(
  await app.request('http://localhost/api/files?drive=global&path=/Shared', undefined, bindings),
)
assert.equal(capped.truncated, true)
const unverifiedUpload = await uploadPool('cannot-prove-unique.txt')
assert.equal(unverifiedUpload.status, 503, 'an incomplete provider survey must not guess that a name is free')
memoryPageSize.delete(driveId)
memoryPageSize.delete('drive-roomy')

// An unknown first segment is a missing folder, not a server fault.
const missing = await app.request('http://localhost/api/files?drive=global&path=/nope/deeper', undefined, bindings)
assert.equal(missing.status, 404)

// A contributor's private root cannot collide with or be adopted by the pool.
store.set('Holiday/private.txt', { bytes: new Uint8Array(1), contentType: 'text/plain' })
const adopting = await mkdirNamed('Holiday')
assert.equal(adopting.status, 201)
assert.ok(store.has('Holiday/private.txt'))
assert.ok(store.has(`${poolProviderPath(driveId, '/Holiday').slice(1)}/`))

async function mkdirNamed(name: string) {
  return app.request(
    'http://localhost/api/files/mkdir?drive=global',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...identify(cyToken).headers as Record<string, string> },
      body: JSON.stringify({ path: '/', name }),
    },
    bindings,
  )
}

// The active drive is a client-side selection, not durable server state. A
// session carrying an old drive id must still be able to remove that drive.
const activeAna = await createSession(bindings, { userId: 'user-1', driveId: 'drive-roomy', username: 'ana' })
const removedActive = await app.request(
  'http://localhost/api/drives/drive-roomy',
  { method: 'DELETE', ...identify(activeAna) },
  bindings,
)
assert.equal(removedActive.status, 200)

db.exec(`
  INSERT INTO drives (id, user_id, provider, name, root_id, refresh_token_enc, granted_scope, created_at, updated_at)
  VALUES ('google-remove', 'user-1', 'google', 'Old Google', 'root', 'encrypted', 'scope', '2026-01-06', '2026-01-06');
`)
const removedGoogle = await app.request(
  'http://localhost/api/drives/google-remove',
  { method: 'DELETE', ...identify(anaToken) },
  bindings,
)
assert.equal(removedGoogle.status, 200)

db.close()
console.log('registry and phase A/B/C checks passed')
