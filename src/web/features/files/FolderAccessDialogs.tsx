import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Dialog, Field } from '@/components/ui'
import { AccessModePicker, PasswordUnlockDialog } from '@/components/AccessControls'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import type { FileItem, StorageAccessMode } from '@/types'

export function FolderAccessDialog({
  item,
  onSave,
  onClose,
}: {
  item: FileItem | null
  onSave: (mode: StorageAccessMode, password: string) => Promise<void>
  onClose: () => void
}) {
  const [mode, setMode] = useState<StorageAccessMode>('public')
  const [password, setPassword] = useState('')
  const { busy, error, setError, run } = useAsyncAction('Could not update folder access')

  useEffect(() => {
    if (!item) return
    setMode(item.accessMode ?? 'public')
    setPassword('')
    setError('')
  }, [item, setError])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const saved = await run(() => onSave(mode, password))
    if (saved) onClose()
  }

  return (
    <Dialog
      open={Boolean(item)}
      onOpenChange={next => { if (!next && !busy) onClose() }}
      dismissable={!busy}
      title={`Access for ${item?.name ?? 'folder'}`}
      description="Applies to this folder and its contents."
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" form="folder-access-form" disabled={busy}>
            {busy ? 'Saving...' : 'Save access'}
          </Button>
        </>
      )}
    >
      <form id="folder-access-form" className="grid gap-3" onSubmit={submit}>
        <fieldset className="grid gap-2">
          <legend className="sr-only">Folder access</legend>
          <AccessModePicker
            name="folder-access"
            value={mode}
            onChange={value => { setMode(value); setPassword(''); setError('') }}
          />
        </fieldset>
        {mode === 'protected' && (
          <Field
            label="Folder password"
            type="password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            hint="At least 8 characters."
            autoComplete="new-password"
            minLength={8}
            maxLength={200}
            required
          />
        )}
        {error && <p className="text-sm text-vault-danger" role="alert">{error}</p>}
      </form>
    </Dialog>
  )
}

export function UnlockFolderDialog({
  item,
  onUnlock,
  onClose,
}: {
  item: FileItem | null
  onUnlock: (password: string) => Promise<void>
  onClose: () => void
}) {
  return (
    <PasswordUnlockDialog
      open={Boolean(item)}
      name={item?.name ?? 'folder'}
      subject="folder"
      onUnlock={onUnlock}
      onClose={onClose}
    />
  )
}
