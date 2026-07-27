import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { Button, Dialog, Field } from './ui'

interface PromptDialogProps {
  open: boolean
  title: string
  label: string
  description?: string
  initialValue?: string
  submitLabel?: string
  selectBasename?: boolean
  onSubmit: (value: string) => void | Promise<void>
  onClose: () => void
}

export function PromptDialog({
  open, title, label, description, initialValue = '', submitLabel = 'Save',
  selectBasename = false, onSubmit, onClose,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue)
  const { busy, error, run } = useAsyncAction('Something went wrong')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setValue(initialValue)
  }, [initialValue, open])

  function focusInput(event: Event) {
    event.preventDefault()
    const input = inputRef.current
    if (!input) return
    input.focus()
    const dot = input.value.lastIndexOf('.')
    if (selectBasename && dot > 0) input.setSelectionRange(0, dot)
    else input.select()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const trimmed = value.trim()
    if (!trimmed || busy) return
    // Stays open on failure so the typed value survives it.
    if (await run(() => onSubmit(trimmed))) onClose()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => { if (!next) onClose() }}
      onOpenAutoFocus={focusInput}
      dismissable={!busy}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" form="prompt-dialog-form" type="submit" disabled={busy || !value.trim()}>
            {busy ? 'Saving...' : submitLabel}
          </Button>
        </>
      }
    >
      <form id="prompt-dialog-form" onSubmit={submit}>
        <Field
          ref={inputRef}
          label={label}
          value={value}
          onChange={event => setValue(event.target.value)}
          error={error || undefined}
          maxLength={255}
          required
        />
      </form>
    </Dialog>
  )
}
