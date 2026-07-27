import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { app } from '../src/worker/index'
import { createSession } from '../src/worker/auth/session'
import { decodeAggregateId } from '../src/worker/drivers/aggregate'
import { multipartRelatedBody } from '../src/worker/drivers/google'
import { PROVIDERS, providerById, validateConfig } from '../src/worker/drivers/registry'
import { pickPlacement, RESERVE_BYTES } from '../src/worker/lib/placement'
import { invalidateStatus, withTimeout } from '../src/worker/lib/status'
import {
  errorOf, identify, memoryQuota, memoryStores, migrate, payload,
  registerMemoryProvider, testBindings,
} from './harness'

const ids = PROVIDERS.map(entry => entry.id)
assert.equal(new Set(ids).size, ids.length)
for (const definition of PROVIDERS) {
  assert.ok(['google', 'webdav', 's3'].includes(definition.base), definition.id)
  if (definition.auth === 'config') assert.ok(definition.fields.length > 0, `${definition.id} needs fields`)
}
const required: Record<'webdav' | 's3', string[]> = {
  webdav: ['url', 'username', 'password'],
  s3: ['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'],
}
for (const definition of PROVIDERS.filter(entry => entry.auth === 'config')) {
  assert.deepEqual(definition.fields.map(field => field.key), required[definition.base as 'webdav' | 's3'])
}
assert.equal(providerById('r2')?.base, 's3')
assert.equal(providerById('nope'), undefined)
await assert.rejects(withTimeout(new Promise<never>(() => {}), 5), /timed out/)
assert.equal(await new Response(multipartRelatedBody(
  new TextEncoder().encode('head:'),
  new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('file')); controller.close() } }),
  new TextEncoder().encode(':tail'),
)).text(), 'head:file:tail')
assert.match((validateConfig('webdav', { url: 'http://insecure', username: 'u', password: 'p' }) as { error: string }).error, /HTTPS/)
assert.ok('ok' in validateConfig('s3', {
  endpoint: 'https://s3.example.com', region: 'auto', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's',
}))

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
const cyToken = await createSession(bindings, { userId: 'user-3', driveId: '', username: 'cyrus', role: 'magician' })

const providers = await payload<{ id: string }[]>(await app.request('http://localhost/api/providers', undefined, bindings))
assert.ok(providers.some(entry => entry.id === 'r2'))
assert.ok(providers.some(entry => entry.id === 'nextcloud'))
const withoutGoogle = await payload<{ id: string }[]>(await app.request(
  'http://localhost/api/providers', undefined,
  testBindings(db, { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }),
))
assert.equal(withoutGoogle.some(entry => entry.id === 'google'), false)

const addDrive = (body: unknown) => app.request(
  'http://localhost/api/drives',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...identify(anaToken).headers as Record<string, string> },
    body: JSON.stringify(body),
  },
  bindings,
)
const added = await addDrive({
  provider: 'r2', name: 'Ana R2',
  config: { endpoint: 'https://acc.r2.cloudflarestorage.com', region: 'auto', bucket: 'pool', accessKeyId: 'k', secretAccessKey: 's' },
})
assert.equal(added.status, 201)
const addedData = await payload<{ provider: string; provider_variant: string }>(added)
assert.equal(addedData.provider, 's3')
assert.equal(addedData.provider_variant, 'r2')
assert.equal((db.prepare("SELECT provider FROM drives WHERE name = 'Ana R2'").get() as { provider: string }).provider, 's3')
assert.equal((await addDrive({ provider: 'google', name: 'x', config: {} })).status, 400)
assert.equal((await addDrive({ provider: 'unknown', name: 'x', config: {} })).status, 400)
const badPreset = await addDrive({ provider: 'nextcloud', name: 'NC', config: { url: 'http://nope', username: 'u', password: 'p' } })
assert.equal(badPreset.status, 400)
assert.match(await errorOf(badPreset), /HTTPS/)

const withVars = (vars: Record<string, string>) => ({ ...bindings as object, ...vars }) as never
const mkdirPool = (vars: Record<string, string>) => app.request(
  'http://localhost/api/files/mkdir?drive=global',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...identify(cyToken).headers as Record<string, string> },
    body: JSON.stringify({ path: '/', name: 'Shared' }),
  },
  withVars(vars),
)
assert.equal((await mkdirPool({ MAGICIAN_USERS: '' })).status, 403)
assert.equal((await mkdirPool({ MAGICIAN_USERS: 'cyrus' })).status, 201)

const driveId = (db.prepare("SELECT id FROM drives WHERE name = 'Ana R2'").get() as { id: string }).id
const upload = (name: string) => app.request(
  `http://localhost/api/files/upload?drive=global&path=/Shared&name=${encodeURIComponent(name)}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'Content-Length': '5', ...identify(cyToken).headers as Record<string, string> },
    body: 'hello',
  },
  bindings,
)
const uploadedResponse = await upload('notes.txt')
assert.equal(uploadedResponse.status, 201)
const uploaded = await payload<{ id: string }>(uploadedResponse)
assert.equal(decodeAggregateId(uploaded.id).driveId, 'managed')
const objectId = decodeAggregateId(uploaded.id).id
const storedCipher = [...(memoryStores.get(driveId)?.entries() ?? [])]
  .find(([key]) => key.includes(`MagicCauldron/objects/${objectId}/`))?.[1].bytes
assert.ok(storedCipher)
assert.notDeepEqual(storedCipher, new TextEncoder().encode('hello'))
const collision = await upload('NOTES.txt')
assert.equal(collision.status, 409)
assert.match(await errorOf(collision), /already (exists|taken)/)
assert.equal(await (await app.request(`http://localhost/api/files/${uploaded.id}/download?drive=global`, undefined, bindings)).text(), 'hello')

memoryQuota.set(driveId, 1024)
await invalidateStatus(bindings as never, driveId)
assert.equal((await app.request('http://localhost/api/capacity?drive=global', undefined, bindings)).status, 403)
const capacity = await payload<{ kind: string; totalBytes: number; knownStorages: number; managedBytes: number }>(
  await app.request('http://localhost/api/capacity?drive=global', identify(cyToken), bindings),
)
assert.equal(capacity.kind, 'pool')
assert.equal(capacity.totalBytes, 1024)
assert.equal(capacity.knownStorages, 1)
assert.equal(capacity.managedBytes, 5)

const roomy = { id: 'roomy' }
const tight = { id: 'tight' }
assert.equal(pickPlacement([
  { entry: tight, healthy: true, held: 0, freeBytes: RESERVE_BYTES + 10 },
  { entry: roomy, healthy: true, held: 20, freeBytes: RESERVE_BYTES + 100 },
], 20), roomy)
assert.equal(pickPlacement([
  { entry: tight, healthy: true, held: 30, freeBytes: null },
  { entry: roomy, healthy: true, held: 10, freeBytes: null },
], 20), roomy)

db.close()
console.log('provider registry and managed placement checks passed')
