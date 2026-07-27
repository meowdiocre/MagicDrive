import { Hono } from 'hono'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { optionalSession, requireSession, tryGetSession, destroySession, effectiveRole, hasDriveUnlock, isMagician, loadAccount, readSession } from './auth/session'
import { createDriver, PROVIDERS } from './drivers/registry'
import type { Capability, StorageDriver } from './drivers/contract'
import { sha256Hex } from './lib/crypto'
import { driveAccessMode } from './lib/access'
import { fail, ok } from './lib/http'
import { isValidName, normalizeVirtualPath } from './lib/path'
import { isPoolContributor, loadPoolRoots } from './lib/pool'
import { authRoutes } from './routes/auth'
import { oauthRoutes } from './routes/oauth'
import { shareRoutes } from './routes/shares'
import { driveRoutes, loadAllDrives, loadDrive } from './routes/drives'
import { vaultRoutes } from './routes/vault'
import { AggregateDriver, GLOBAL_DRIVE_ID, POOL_NAME } from './drivers/aggregate'
import { VaultDriver } from './drivers/vault'
import { retryPoolDeletions } from './lib/pool'
import { cleanupExpiredUploads, VAULT_DRIVE_ID, VAULT_NAME } from './lib/vault'
import type { AppEnv, Bindings, DriveRecord, Session } from './types'

const app = new Hono<AppEnv>()

const MAX_UPLOAD_BYTES = 95 * 1024 * 1024 // Workers request cap is 100 MB; chunked/resumable upload when large files matter.

app.use('*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'same-origin')
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store')
})

app.onError((error, c) => {
  // Expected refusals carry their own status and are not worth logging as faults.
  if (error instanceof HTTPException) return fail(c, error.message, error.status)
  console.error(JSON.stringify({
    message: 'Unhandled request error',
    method: c.req.method,
    path: c.req.path,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }))
  return fail(c, 'Internal server error', 500)
})

app.get('/api/health', c => ok(c, {
  name: 'MagicDrive',
  version: '0.3.0',
  // Accounts and encryption both hang off the one secret; Google only gates the
  // Drive connector, so its absence narrows the provider list rather than the app.
  configured: Boolean(c.env.DATA_ENCRYPTION_KEY),
  invite: Boolean(c.env.INVITE_SPELL),
  providers: ['google', 'webdav', 's3'].filter(id => id !== 'google' || googleConfigured(c.env)),
}))

app.route('/api/auth', authRoutes)
app.route('/api/auth', oauthRoutes)

function googleConfigured(env: AppEnv['Bindings']): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
}

app.get('/api/auth/me', async c => {
  const session = await readSession(c.req.raw, c.env)
  if (!session) return ok(c, { user: null })
  // Read the account fresh. A session outlives a role change by up to two weeks,
  // and one minted before spell auth carries no username at all.
  const account = await loadAccount(c.env, session.userId)
  if (!account) return ok(c, { user: null })
  return ok(c, { user: { ...session, username: account.username, role: effectiveRole(c.env, account) } })
})

app.post('/api/auth/logout', async c => {
  const headers = await destroySession(c.req.raw, c.env)
  const cookie = headers.get('Set-Cookie')
  if (cookie) c.header('Set-Cookie', cookie)
  return c.json({ data: { loggedOut: true } }, 200)
})

// Browsing and downloading are public. Signing in is only needed to contribute
// storage, and then only for the drives you own.
for (const route of ['/api/files', '/api/files/*', '/api/search', '/api/drives', '/api/drives/*']) {
  app.use(route, optionalSession)
}
for (const route of ['/api/drives', '/api/drives/*']) {
  app.use(route, async (c, next) => {
    if (c.req.method === 'GET' || (c.req.method === 'POST' && c.req.path.endsWith('/unlock'))) return next()
    return requireSession(c, next)
  })
}
for (const route of ['/api/shares', '/api/shares/*', '/api/vault', '/api/vault/*']) {
  app.use(route, requireSession)
}

app.route('/api/shares', shareRoutes)
app.route('/api/drives', driveRoutes)
app.route('/api/vault', vaultRoutes)

const WRITE_CAPABILITIES: readonly Capability[] = ['upload', 'mkdir', 'delete', 'rename']

type Resolved = {
  driver: StorageDriver
  drive: DriveRecord
  /** What the caller may do at a given path. The pooled view answers differently per folder. */
  allowed: (path: string) => readonly Capability[]
  /** Rename and delete address a file by id and have no path to check. */
  canWrite: boolean
}

const POOLED_DRIVE: DriveRecord = {
  id: GLOBAL_DRIVE_ID, user_id: '', provider: 'global',
  name: POOL_NAME, root_id: 'root',
  refresh_token_enc: null, config_enc: null, granted_scope: '',
}

const VAULT_DRIVE: DriveRecord = {
  id: VAULT_DRIVE_ID, user_id: '', provider: 'vault',
  name: VAULT_NAME, root_id: 'root',
  refresh_token_enc: null, config_enc: null, granted_scope: '',
}

/** Null when nothing is connected yet, which is an empty state rather than an error. */
async function resolveDriver(c: Context<AppEnv>): Promise<Resolved | null> {
  const session = tryGetSession(c)
  const requested = c.req.query('drive') || session?.driveId

  if (requested === VAULT_DRIVE_ID) {
    // Any signed-in member may write; the driver checks ownership per object.
    const driver = new VaultDriver(c.env, session?.userId ?? null)
    const allowed = session
      ? driver.capabilities
      : driver.capabilities.filter(capability => !WRITE_CAPABILITIES.includes(capability))
    return { driver, drive: VAULT_DRIVE, allowed: () => allowed, canWrite: Boolean(session) }
  }

  if (requested && requested !== GLOBAL_DRIVE_ID) {
    const drive = await loadDrive(c, requested)
    if (!drive) throw new HTTPException(404, { message: 'Storage not found' })
    await assertDriveReadable(c, drive, session)
    return connectionDriver(c, drive, session)
  }

  const [allDrives, roots, magician] = await Promise.all([
    loadAllDrives(c),
    loadPoolRoots(c.env.DB),
    isMagician(c),
  ])
  const poolDrives = allDrives.filter(isPoolContributor)
  if (requested === GLOBAL_DRIVE_ID) {
    if (poolDrives.length === 0) return null
    const driver = new AggregateDriver(c.env, poolDrives, roots, {
      userId: session?.userId ?? null,
      isMagician: magician,
    })
    return { driver, drive: POOLED_DRIVE, allowed: path => driver.allowed(path), canWrite: magician }
  }

  const readable = (await Promise.all(allDrives.map(async drive =>
    await canReadDrive(c, drive, session) ? drive : null
  ))).filter((drive): drive is DriveRecord => drive !== null)
  if (readable.length === 0) return null
  // A lone connection is its own view; the pool only earns a landing once there
  // is more than one, or the caller asked for it.
  if (readable.length === 1 || poolDrives.length < 2) return connectionDriver(c, readable[0], session)

  const driver = new AggregateDriver(c.env, poolDrives, roots, {
    userId: session?.userId ?? null,
    isMagician: magician,
  })
  return { driver, drive: POOLED_DRIVE, allowed: path => driver.allowed(path), canWrite: magician }
}

async function canReadDrive(c: Context<AppEnv>, drive: DriveRecord, session: Session | null): Promise<boolean> {
  const mode = driveAccessMode(drive)
  if (mode === 'private') return session?.userId === drive.user_id
  if (mode === 'protected') return hasDriveUnlock(c.req.raw, c.env, drive.id)
  return true
}

async function assertDriveReadable(c: Context<AppEnv>, drive: DriveRecord, session: Session | null): Promise<void> {
  const mode = driveAccessMode(drive)
  if (mode === 'private' && session?.userId !== drive.user_id) {
    throw new HTTPException(404, { message: 'Storage not found' })
  }
  if (mode === 'protected' && !await hasDriveUnlock(c.req.raw, c.env, drive.id)) {
    throw new HTTPException(423, { message: 'Storage password required' })
  }
}

function connectionDriver(c: Context<AppEnv>, drive: DriveRecord, session: Session | null): Resolved {
  const driver = createDriver(c.env, drive)
  const canWrite = Boolean(session && drive.user_id === session.userId)
  const allowed = canWrite
    ? driver.capabilities
    : driver.capabilities.filter(capability => !WRITE_CAPABILITIES.includes(capability))
  return { driver, drive, allowed: () => allowed, canWrite }
}

interface WriteRequest {
  capability: Capability
  /** Fills "only the owner can ..." in a refusal. */
  action: string
  /** Fills "this provider does not support ..." when the provider is the limit. */
  support: string
  /** Path-addressed writes only; rename and delete carry an id instead. */
  path?: string
}

/** Resolves a drive for a write, or throws the reason the write is not allowed. */
async function resolveForWrite(c: Context<AppEnv>, request: WriteRequest): Promise<Resolved> {
  if (!tryGetSession(c)) {
    throw new HTTPException(401, { message: `Sign in to ${request.action} in storage you own` })
  }
  const resolved = await resolveDriver(c)
  if (!resolved) throw new HTTPException(404, { message: 'No storage is connected yet' })
  if (!resolved.driver.capabilities.includes(request.capability)) {
    throw new HTTPException(400, { message: `This provider does not support ${request.support}` })
  }
  const allowed = request.path === undefined
    ? (resolved.canWrite ? resolved.driver.capabilities : [])
    : resolved.allowed(request.path)
  if (!allowed.includes(request.capability)) {
    throw new HTTPException(403, {
      message: resolved.drive.id === GLOBAL_DRIVE_ID
        ? `${POOL_NAME} is shared storage: only a magician can ${request.action} here`
        : `Read-only storage: only the owner can ${request.action}`,
    })
  }
  return resolved
}

app.get('/api/files', async c => {
  const path = requestPath(c.req.query('path'))
  const resolved = await resolveDriver(c)
  if (!resolved) {
    return ok(c, { path, items: [], nextPageToken: null, capabilities: [], canWrite: false, driveId: null, provider: null })
  }
  const { driver, drive } = resolved
  const result = await driver.list(path, c.req.query('pageToken'))
  const capabilities = resolved.allowed(path)
  const canWrite = capabilities.some(capability => WRITE_CAPABILITIES.includes(capability))
  return ok(c, { ...result, capabilities, canWrite, driveId: drive.id, provider: drive.provider })
})

app.get('/api/providers', c => {
  const google = googleConfigured(c.env)
  return ok(c, PROVIDERS.filter(p => google || p.auth !== 'oauth'))
})

app.get('/api/search', async c => {
  const resolved = await resolveDriver(c)
  if (!resolved) return ok(c, { items: [] })
  if (!resolved.driver.capabilities.includes('search')) return fail(c, 'This provider does not support search', 400)
  return ok(c, { items: await resolved.driver.search(c.req.query('q') ?? '') })
})

/** A caller-supplied path is a bad request, not a fault, when it cannot be normalized. */
function requestPath(value: string | null | undefined): string {
  try {
    return normalizeVirtualPath(value)
  } catch {
    throw new HTTPException(400, { message: 'Invalid path' })
  }
}

app.post('/api/files/upload', async c => {
  const path = requestPath(c.req.query('path'))
  const { driver } = await resolveForWrite(c, { capability: 'upload', action: 'upload', support: 'upload', path })
  const filename = (c.req.query('name') ?? '').trim()
  if (!isValidName(filename)) return fail(c, 'Invalid filename', 400)
  // The stream is handed to the provider untouched, so the declared length is
  // the only size this Worker ever knows.
  const size = Number(c.req.header('Content-Length') ?? 0)
  if (!Number.isFinite(size) || size <= 0) return fail(c, 'Empty upload', 400)
  if (size > MAX_UPLOAD_BYTES) return fail(c, 'File too large (95 MB max)', 413)
  const contentType = c.req.header('Content-Type') || 'application/octet-stream'
  const body = c.req.raw.body
  if (!body) return fail(c, 'Empty upload', 400)
  const item = await driver.upload(path, filename, body, contentType, size)
  return ok(c, item, 201)
})

app.post('/api/files/mkdir', async c => {
  const body = await c.req.json<{ path?: string; name?: string }>().catch(() => null)
  const path = requestPath(body?.path)
  const { driver } = await resolveForWrite(c, { capability: 'mkdir', action: 'create folders', support: 'folders', path })
  const name = (body?.name ?? '').trim()
  if (!isValidName(name)) return fail(c, 'Invalid folder name', 400)
  // A folder conjured in the pool lands on every connection, and any that refused
  // it belongs in the response rather than in a log the magician will never read.
  if (driver instanceof AggregateDriver) {
    const { item, storages } = await driver.conjureFolder(path, name)
    return ok(c, { ...item, storages }, 201)
  }
  return ok(c, await driver.mkdir(path, name), 201)
})

app.patch('/api/files/:id', async c => {
  const { driver } = await resolveForWrite(c, { capability: 'rename', action: 'rename', support: 'rename' })
  const body = await c.req.json<{ name?: string; path?: string }>().catch(() => null)
  const name = (body?.name ?? '').trim()
  if (!isValidName(name)) return fail(c, 'Invalid name', 400)
  return ok(c, await driver.rename(c.req.param('id'), name, body?.path))
})

app.delete('/api/files/:id', async c => {
  const { driver } = await resolveForWrite(c, { capability: 'delete', action: 'delete', support: 'delete' })
  await driver.remove(c.req.param('id'))
  return ok(c, { deleted: true })
})

// Everything outside this list downloads instead of rendering.
const INLINE_SAFE_TYPES = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/|audio\/|application\/pdf|text\/plain)/i

// File bytes are served from the app's own origin. Without the sandbox CSP, a member
// could upload HTML to their own drive and run it as script in another member's session.
function hardenContent(response: Response, disposition: 'attachment' | 'inline'): Response {
  const headers = new Headers(response.headers)
  headers.set('Content-Security-Policy', "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'")
  if (disposition === 'inline' && !INLINE_SAFE_TYPES.test(headers.get('Content-Type') ?? '')) {
    headers.set('Content-Type', 'application/octet-stream')
    const existing = headers.get('Content-Disposition') ?? ''
    headers.set('Content-Disposition', existing.startsWith('inline') ? existing.replace(/^inline/, 'attachment') : 'attachment')
  }
  return new Response(response.body, { status: response.status, headers })
}

async function resolveForRead(c: Context<AppEnv>): Promise<Resolved> {
  const resolved = await resolveDriver(c)
  if (!resolved) throw new HTTPException(404, { message: 'No storage is connected yet' })
  return resolved
}

app.get('/api/files/:id/download', async c => {
  const { driver } = await resolveForRead(c)
  return hardenContent(await driver.download(c.req.param('id'), c.req.raw), 'attachment')
})

app.get('/api/files/:id/raw', async c => {
  const { driver } = await resolveForRead(c)
  return hardenContent(await driver.download(c.req.param('id'), c.req.raw, 'inline'), 'inline')
})

app.get('/api/files/:id/thumbnail', async c => {
  const { driver } = await resolveForRead(c)
  return hardenContent(await driver.thumbnail(c.req.param('id')), 'inline')
})

app.get('/s/:token', async c => {
  const token = c.req.param('token')
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return fail(c, 'Invalid share link', 400)
  const share = await c.env.DB.prepare(
    `SELECT s.file_id, s.expires_at, s.virtual_drive_id,
            d.id, d.user_id, d.provider, d.name, d.root_id,
            d.refresh_token_enc, d.config_enc, d.granted_scope
     FROM shares s LEFT JOIN drives d ON d.id = s.drive_id
     WHERE s.token_hash = ?`
  ).bind(await sha256Hex(token)).first<SharedDownload>()
  if (!share) return fail(c, 'Share link not found', 404)
  if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
    return fail(c, 'Share link has expired', 410)
  }
  if (share.virtual_drive_id === VAULT_DRIVE_ID) {
    return hardenContent(await new VaultDriver(c.env, null).download(share.file_id, c.req.raw, 'inline'), 'inline')
  }
  const drive = shareDrive(share)
  if (!drive) return fail(c, 'Share storage no longer exists', 404)
  const driver = share.virtual_drive_id === GLOBAL_DRIVE_ID
    ? new AggregateDriver(c.env, [drive], [], { userId: null, isMagician: false })
    : createDriver(c.env, drive)
  return hardenContent(await driver.download(share.file_id, c.req.raw, 'inline'), 'inline')
})

interface SharedDownload {
  file_id: string
  expires_at: string | null
  virtual_drive_id: string | null
  id: string | null
  user_id: string | null
  provider: DriveRecord['provider'] | null
  name: string | null
  root_id: string | null
  refresh_token_enc: string | null
  config_enc: string | null
  granted_scope: string | null
}

function shareDrive(share: SharedDownload): DriveRecord | null {
  if (!share.id || !share.user_id || !share.provider || !share.name || !share.root_id || share.granted_scope === null) {
    return null
  }
  return {
    id: share.id,
    user_id: share.user_id,
    provider: share.provider,
    name: share.name,
    root_id: share.root_id,
    refresh_token_enc: share.refresh_token_enc,
    config_enc: share.config_enc,
    granted_scope: share.granted_scope,
  }
}

app.notFound(c => {
  if (c.req.path.startsWith('/api/')) return fail(c, 'Not found', 404)
  return c.env.ASSETS.fetch(c.req.raw)
})

export { app }

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    // Expired vault uploads and half-finished pooled deletions, swept hourly.
    ctx.waitUntil(cleanupExpiredUploads(env))
    ctx.waitUntil(retryPoolDeletions(env))
  },
}
