import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { Button, Dialog, Field } from '@/components/ui'

interface UnlockStorageDialogProps {
  open: boolean
  name: string
  onUnlock: (password: string) => Promise<void>
  onClose: () => void
}

export function UnlockStorageDialog({ open, name, onUnlock, onClose }: UnlockStorageDialogProps) {
  const [password, setPassword] = useState('')
  const { busy, error, setError, run } = useAsyncAction('Unable to unlock storage')

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
      description="Enter the storage password to browse its files."
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" form="unlock-storage-form" type="submit" disabled={busy}>
            {busy ? 'Unlocking...' : 'Unlock storage'}
          </Button>
        </>
      )}
    >
      <form id="unlock-storage-form" className="grid gap-3" onSubmit={submit}>
        <Field
          label="Storage password"
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
