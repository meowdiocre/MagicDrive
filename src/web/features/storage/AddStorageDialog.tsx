import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Cloud, HardDrive, Layers, Link2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { apiGet } from '@/api/client'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/cn'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { Button, Dialog, Field } from '@/components/ui'
import { AccessModePicker } from '@/components/AccessControls'
import type { DrivesState } from './useDrives'
import type { ProviderDef, StorageAccessMode } from '@/types'

const BASE_ICONS: Record<ProviderDef['base'], LucideIcon> = {
  google: Cloud,
  webdav: Link2,
  s3: HardDrive,
}

const FALLBACK_PROVIDERS: ProviderDef[] = [
  { id: 'google', label: 'Google Drive', base: 'google', auth: 'oauth', capabilities: [], fields: [] },
  {
    id: 'webdav', label: 'WebDAV', base: 'webdav', auth: 'config', capabilities: [],
    fields: [
      { key: 'url', label: 'WebDAV URL', placeholder: 'https://dav.example.com/remote.php/webdav' },
      { key: 'username', label: 'Username' },
      { key: 'password', label: 'Password', type: 'password' },
    ],
  },
  {
    id: 's3', label: 'S3-compatible', base: 's3', auth: 'config', capabilities: [],
    fields: [
      { key: 'endpoint', label: 'Endpoint URL', placeholder: 'https://<account>.r2.cloudflarestorage.com' },
      { key: 'region', label: 'Region', placeholder: 'auto' },
      { key: 'bucket', label: 'Bucket' },
      { key: 'accessKeyId', label: 'Access key ID' },
      { key: 'secretAccessKey', label: 'Secret access key', type: 'password' },
    ],
  },
]

function prefill(definition: ProviderDef): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of definition.fields) {
    if (field.value) values[field.key] = field.value
  }
  return values
}

export function AddStorageDialog({ open, drives, onClose }: { open: boolean; drives: DrivesState; onClose: () => void }) {
  const [providers, setProviders] = useState<ProviderDef[]>(FALLBACK_PROVIDERS)
  const [providerId, setProviderId] = useState('google')
  const [name, setName] = useState('')
  const [config, setConfig] = useState<Record<string, string>>({})
  const [accessMode, setAccessMode] = useState<StorageAccessMode>('public')
  const [password, setPassword] = useState('')
  const [poolContributor, setPoolContributor] = useState(true)
  const { busy, error, setError, run } = useAsyncAction('Unable to connect storage')

  useEffect(() => {
    if (!open) return
    apiGet<ProviderDef[]>('/api/providers', 'Unable to load providers')
      .then(list => { if (list.length > 0) setProviders(list) })
      .catch(cause => notify.error(cause, 'Using built-in providers'))
  }, [open])

  const active = useMemo(
    () => providers.find(entry => entry.id === providerId) ?? providers[0],
    [providers, providerId],
  )
  const isOAuth = active.auth === 'oauth'

  function reset() {
    setName('')
    setConfig({})
    setAccessMode('public')
    setPassword('')
    setPoolContributor(true)
    setError('')
    setProviderId('google')
  }

  function pickProvider(definition: ProviderDef) {
    setProviderId(definition.id)
    setConfig(prefill(definition))
    setError('')
    const labels = providers.map(entry => entry.label)
    if (definition.id !== definition.base && (!name || labels.includes(name))) setName(definition.label)
    else if (definition.id === definition.base && labels.includes(name)) setName('')
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const connected = await run(async () => {
      if (isOAuth) {
        const { url } = await drives.startOAuth(active.id, accessMode, password, poolContributor)
        window.location.assign(url)
        return
      }
      await drives.addDrive(active.id, name, config, accessMode, password, poolContributor)
      notify.success(`Connected ${name}`)
    })
    if (connected && !isOAuth) {
      reset()
      onClose()
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => { if (!next) { reset(); onClose() } }}
      dismissable={!busy}
      title="Connect storage"
      description="Visibility and Cauldron contribution are separate."
      className="w-[min(34rem,calc(100vw-2rem))] max-[40rem]:bottom-0 max-[40rem]:top-auto max-[40rem]:max-h-[calc(100dvh-0.5rem)] max-[40rem]:w-full max-[40rem]:translate-y-0 max-[40rem]:rounded-b-none max-[40rem]:border-x-0 max-[40rem]:border-b-0"
      footer={(
        <>
          <Button variant="secondary" onClick={() => { reset(); onClose() }} disabled={busy}>Cancel</Button>
          <Button variant="primary" form="add-storage-form" type="submit" disabled={busy}>
            {busy ? 'Connecting...' : isOAuth ? `Continue with ${active.label}` : 'Connect storage'}
          </Button>
        </>
      )}
    >
      <form id="add-storage-form" className="grid gap-4" onSubmit={submit}>
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium text-vault-ink">Provider</legend>
          <div className="grid grid-cols-3 gap-2 max-[26rem]:grid-cols-1">
            {providers.map(entry => {
              const Icon = BASE_ICONS[entry.base] ?? HardDrive
              return (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={active.id === entry.id}
                  onClick={() => pickProvider(entry)}
                  className={cn(
                    'flex min-h-14 flex-col items-start justify-center gap-1 rounded-vault-sm border border-vault-rule bg-vault-paper px-3 text-left text-sm transition-colors duration-(--dur-fast) hover:border-vault-rule-strong',
                    active.id === entry.id && 'border-vault-accent bg-vault-accent-soft text-vault-accent',
                  )}
                >
                  <Icon className="size-4" />
                  <span className="font-medium">{entry.label}</span>
                </button>
              )
            })}
          </div>
        </fieldset>

        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium text-vault-ink">Access</legend>
          <AccessModePicker
            name="storage-access"
            value={accessMode}
            onChange={value => {
              setAccessMode(value)
              if (value !== 'protected') setPassword('')
              setError('')
            }}
          />
        </fieldset>

        {accessMode === 'protected' && (
          <Field
            label="Storage password"
            type="password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            hint="At least 8 characters. This password cannot be recovered."
            autoComplete="new-password"
            minLength={8}
            maxLength={200}
            required
          />
        )}

        <label className="flex cursor-pointer items-start gap-3 rounded-vault-sm border border-vault-rule bg-vault-paper px-3 py-2.5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-vault-accent-soft">
          <input
            className="mt-1 size-4 accent-vault-accent"
            type="checkbox"
            checked={poolContributor}
            onChange={event => setPoolContributor(event.target.checked)}
          />
          <span className="grid min-w-0 gap-0.5">
            <span className="flex items-center gap-1.5 text-sm font-medium text-vault-ink"><Layers className="size-4 text-vault-accent" /> Contribute capacity to The Cauldron</span>
            <span className="text-xs leading-relaxed text-vault-muted">Personal files stay private.</span>
          </span>
        </label>

        {isOAuth ? (
          <p className="text-sm leading-relaxed text-vault-muted">
            Continue to {active.label} to authorize file access.
          </p>
        ) : (
          <>
            <Field
              label="Display name"
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder="My NAS"
              hint="You can rename this later."
              maxLength={100}
              required
            />

            {active.fields.map(field => (
              <Field
                key={`${active.id}-${field.key}`}
                label={field.label}
                type={field.type ?? 'text'}
                value={config[field.key] ?? ''}
                onChange={event => setConfig(current => ({ ...current, [field.key]: event.target.value }))}
                placeholder={field.placeholder}
                hint={field.hint}
                autoComplete="off"
                required
              />
            ))}
          </>
        )}

        {error && <p className="text-sm text-vault-danger" role="alert">{error}</p>}
      </form>
    </Dialog>
  )
}
