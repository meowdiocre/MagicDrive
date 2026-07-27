import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { app } from '../src/worker/index'
import {
  USERNAME_PATTERN,
  normalizeSpell,
  normalizeUsername,
  spellHash,
  spellWeakness,
  spellWords,
} from '../src/worker/lib/spell'
import { SPELL_BITS, SPELL_LENGTH, SPELL_WORDS, conjureSpell } from '../src/web/features/auth/spell'
import { errorOf, migrate, payload, testBindings } from './harness'

// --- Spells -----------------------------------------------------------------

// However it is typed back, the same phrase has to open the same account.
assert.equal(normalizeSpell('Ember Thistle Lantern'), 'ember-thistle-lantern')
assert.equal(normalizeSpell('  ember--thistle  lantern  '), 'ember-thistle-lantern')
assert.equal(normalizeSpell('EMBER, THISTLE. LANTERN!'), 'ember-thistle-lantern')
assert.equal(normalizeSpell('ember-thistle-lantern'), 'ember-thistle-lantern')
// Letters outside ASCII are kept rather than stripped, which would collapse
// two different spells onto one hash.
assert.equal(normalizeSpell('Ærø thistle 東京'), 'ærø-thistle-東京')
assert.notEqual(normalizeSpell('åter thistle lantern'), normalizeSpell('ater thistle lantern'))
assert.deepEqual(spellWords('Ember Thistle Lantern'), ['ember', 'thistle', 'lantern'])
assert.equal(normalizeSpell('   '), '')

assert.match(spellWeakness('short') ?? '', /at least 16 characters/)
assert.match(spellWeakness('abcdefghijklmnopq') ?? '', /at least 3 words/)
assert.equal(spellWeakness('ember thistle lantern'), null)
assert.equal(spellWeakness('correcthorsebatterystaple'), null)
assert.equal(spellWeakness(conjureSpell()), null)

assert.equal(normalizeUsername('  Cinderquill '), 'cinderquill')
for (const name of ['ana', 'cinder-quill', 'wizard_9', 'a1b']) assert.equal(USERNAME_PATTERN.test(name), true, name)
for (const name of ['ab', '-ana', 'Ana', 'ana bell', 'a'.repeat(25), '']) {
  assert.equal(USERNAME_PATTERN.test(name), false, name)
}

const hash = await spellHash('secret', 'Ember Thistle Lantern')
assert.match(hash, /^[0-9a-f]{64}$/)
assert.equal(await spellHash('secret', 'ember-thistle-lantern'), hash)
// The key is what makes a leaked table useless on its own.
assert.notEqual(await spellHash('other-secret', 'Ember Thistle Lantern'), hash)
assert.notEqual(await spellHash('secret', 'ember thistle lanterns'), hash)

// --- Generated spells -------------------------------------------------------

assert.equal(new Set(SPELL_WORDS).size, SPELL_WORDS.length, 'wordlist must not repeat a word')
assert.equal(SPELL_WORDS.every(word => /^[a-z]{2,9}$/.test(word)), true)
assert.equal(SPELL_BITS > 50, true, `a conjured spell carries ${SPELL_BITS.toFixed(1)} bits`)
const conjured = conjureSpell()
assert.equal(conjured.split('-').length, SPELL_LENGTH)
assert.equal(conjured.split('-').every(word => SPELL_WORDS.includes(word)), true)
assert.notEqual(conjureSpell(), conjureSpell())

// --- Registering and signing in ---------------------------------------------

const db = new DatabaseSync(':memory:')
migrate(db)
const bindings = testBindings(db, { MAGICIAN_USERS: 'cyrus' })

const SPELL = 'ember-thistle-lantern-quill-moth-cinder-bramble'
const post = (path: string, body: unknown, init: RequestInit = {}) => app.request(
  `http://localhost/api/auth/${path}`,
  { method: 'POST', ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) }, body: JSON.stringify(body) },
  bindings,
)
const cookieOf = (response: Response) => (response.headers.get('Set-Cookie') ?? '').split(';')[0]

const registered = await post('register', { username: 'ana', spell: SPELL })
assert.equal(registered.status, 201)
assert.equal(await payload<{ user: { username: string } }>(registered).then(data => data.user.username), 'ana')
const anaCookie = cookieOf(registered)
assert.match(anaCookie, /^vd_session=/)

// The cookie the response set is a working session.
const me = await app.request('http://localhost/api/auth/me', { headers: { Cookie: anaCookie } }, bindings)
const session = await payload<{ user: { username: string; role: string; driveId: string } }>(me)
assert.equal(session.user.username, 'ana')
assert.equal(session.user.role, 'owner')
// Nothing is connected yet, so the account carries no drive.
assert.equal(session.user.driveId, '')

assert.equal((await post('register', { username: 'ana', spell: conjureSpell() })).status, 409)
assert.match(await errorOf(await post('register', { username: 'bee', spell: SPELL })), /spell is already in use/)
assert.match(await errorOf(await post('register', { username: 'bee', spell: 'weak' })), /at least 16 characters/)
assert.match(await errorOf(await post('register', { username: 'B', spell: conjureSpell() })), /3–24 characters/)

// Casing and spacing do not change which account a spell opens.
const relogin = await post('login', { spell: ' EMBER thistle, lantern quill moth cinder bramble ' })
assert.equal(relogin.status, 200)
assert.equal(await payload<{ user: { username: string } }>(relogin).then(data => data.user.username), 'ana')

const wrong = await post('login', { spell: conjureSpell() }, { headers: { 'CF-Connecting-IP': '10.0.0.1' } })
assert.equal(wrong.status, 401)
// The same message either way: which spells exist is not something to leak.
assert.equal(await errorOf(wrong), 'That spell opens nothing')
assert.equal((await post('login', { spell: '' })).status, 400)

// --- The magician role ------------------------------------------------------

const cy = await post('register', { username: 'cyrus', spell: conjureSpell() })
assert.equal(cy.status, 201)
assert.equal(await payload<{ user: { role: string } }>(cy).then(data => data.user.role), 'magician')
const cyCookie = cookieOf(cy)
assert.equal(
  (db.prepare("SELECT role FROM users WHERE username = 'cyrus'").get() as { role: string }).role,
  'magician',
)

// OAuth state is tied to the account that started it. Without this check, one
// signed-in member could replace another member's Google credentials.
const oauthStart = await app.request(
  'http://localhost/api/auth/google/start',
  {
    method: 'POST',
    headers: { Cookie: anaCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessMode: 'public' }),
  },
  bindings,
)
assert.equal(oauthStart.status, 200)
const oauthState = new URL((await payload<{ url: string }>(oauthStart)).url).searchParams.get('state')!
const crossedOAuth = await app.request(
  `http://localhost/api/auth/google/callback?state=${encodeURIComponent(oauthState)}&code=unused`,
  { headers: { Cookie: cyCookie } },
  bindings,
)
assert.equal(crossedOAuth.status, 403)
assert.match(await errorOf(crossedOAuth), /another session/)

// Taking the name out of MAGICIAN_USERS drops the role at the next sign-in.
const cySpell = 'vesper-marrow-kestrel-gossamer-nimbus-plume-quartz'
db.prepare("UPDATE users SET spell_hash = ? WHERE username = 'cyrus'")
  .run(await spellHash('encryption-key', cySpell))
const demoted = await app.request(
  'http://localhost/api/auth/login',
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spell: cySpell }) },
  testBindings(db, { MAGICIAN_USERS: '' }),
)
assert.equal(await payload<{ user: { role: string } }>(demoted).then(data => data.user.role), 'owner')
assert.equal((db.prepare("SELECT role FROM users WHERE username = 'cyrus'").get() as { role: string }).role, 'owner')

// --- Guarding the door ------------------------------------------------------

const invited = testBindings(db, { INVITE_SPELL: 'friend-of-the-coven' })
const uninvited = await app.request(
  'http://localhost/api/auth/register',
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'dee', spell: conjureSpell() }) },
  invited,
)
assert.equal(uninvited.status, 403)
assert.match(await errorOf(uninvited), /invite spell is not recognised/)

const welcomed = await app.request(
  'http://localhost/api/auth/register',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'dee', spell: conjureSpell(), invite: 'Friend of the Coven' }),
  },
  invited,
)
assert.equal(welcomed.status, 201)

// A spell is the whole credential, so guessing at it is throttled.
const throttleDb = new DatabaseSync(':memory:')
migrate(throttleDb)
const throttleBindings = testBindings(throttleDb)
const guess = () => app.request(
  'http://localhost/api/auth/login',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
    body: JSON.stringify({ spell: conjureSpell() }),
  },
  throttleBindings,
)
for (let attempt = 0; attempt < 10; attempt += 1) assert.equal((await guess()).status, 401)
const throttledResponse = await guess()
assert.equal(throttledResponse.status, 429)
assert.match(await errorOf(throttledResponse), /Too many attempts/)
throttleDb.close()

// --- Signing out ------------------------------------------------------------

// A cookie pointing at an account that no longer exists is not a session.
const deeCookie = cookieOf(welcomed)
db.exec("DELETE FROM users WHERE username = 'dee'")
const orphaned = await app.request('http://localhost/api/auth/me', { headers: { Cookie: deeCookie } }, invited)
assert.equal(await payload<{ user: unknown }>(orphaned).then(data => data.user), null)

const signedOut = await app.request(
  'http://localhost/api/auth/logout',
  { method: 'POST', headers: { Cookie: anaCookie } },
  bindings,
)
assert.equal(signedOut.status, 200)
const afterLogout = await app.request('http://localhost/api/auth/me', { headers: { Cookie: anaCookie } }, bindings)
assert.equal(await payload<{ user: unknown }>(afterLogout).then(data => data.user), null)
db.close()

console.log('spell auth checks passed')
