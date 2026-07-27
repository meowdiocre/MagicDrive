import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { EyeOff, Globe2, LockKeyhole } from 'lucide-react'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { cn } from '@/lib/cn'
import { Button, Dialog, Field } from './ui'
import type { StorageAccessMode } from '@/types'

const accessOptions = [
  { value: 'public', label: 'Public', description: 'Anyone can open it.', icon: Globe2 },
  { value: 'protected', label: 'Password protected', description: 'A password is required.', icon: LockKeyhole },
  { value: 'private', label: 'Private', description: 'Only authorized users can open it.', icon: EyeOff },
] as const

export function AccessModePicker({
  name,
  value,
  onChange,
}: {
  name: string
  value: StorageAccessMode
  onChange: (value: StorageAccessMode) => void
}) {
  return (
    <div className="grid gap-2">
      {accessOptions.map(option => {
        const Icon = option.icon
        const selected = value === option.value
        return (
          <label
            key={option.value}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-vault-sm border border-vault-rule bg-vault-paper px-3 py-2.5 transition-colors duration-(--dur-fast) hover:border-vault-rule-strong',
              'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-vault-accent-soft',
              selected && 'border-vault-accent bg-vault-accent-soft',
            )}
          >
            <input
              className="sr-only"
              type="radio"
              name={name}
              value={option.value}
              checked={selected}
              onChange={() => onChange(option.value)}
            />
            <Icon className={cn('mt-0.5 size-4 shrink-0 text-vault-subtle', selected && 'text-vault-accent')} />
            <span className="grid min-w-0 gap-0.5">
              <span className="text-sm font-medium text-vault-ink">{option.label}</span>
              <span className="text-xs text-vault-muted">{option.description}</span>
            </span>
          </label>
        )
      })}
    </div>
  )
}

export function PasswordUnlockDialog({
  open,
  name,
  subject,
  onUnlock,
  onClose,
}: {
  open: boolean
  name: string
  subject: 'folder' | 'storage'
  onUnlock: (password: string) => Promise<void>
  onClose: () => void
}) {
  const [password, setPassword] = useState('')
  const { busy, error, setError, run } = useAsyncAction(`Unable to unlock ${subject}`)
  const formId = `unlock-${subject}-form`

  useEffect(() => {
    if (!open) return
    setPassword('')
    setError('')
  }, [name, open, setError])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const unlocked = await run(() => onUnlock(password))
    if (unlocked) onClose()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => { if (!next && !busy) onClose() }}
      dismissable={!busy}
      title={`Unlock ${name}`}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" form={formId} type="submit" disabled={busy}>
            {busy ? 'Unlocking...' : `Unlock ${subject}`}
          </Button>
        </>
      )}
    >
      <form id={formId} className="grid gap-3" onSubmit={submit}>
        <Field
          label={`${subject[0].toUpperCase()}${subject.slice(1)} password`}
          type="password"
          value={password}
          onChange={event => setPassword(event.target.value)}
          autoComplete="current-password"
          minLength={8}
          maxLength={200}
          required
          autoFocus
        />
        {error && <p className="text-sm text-vault-danger" role="alert">{error}</p>}
      </form>
    </Dialog>
  )
}
