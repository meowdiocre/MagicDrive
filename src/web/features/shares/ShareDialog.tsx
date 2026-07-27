import { useState } from 'react'
import { Check, Copy, Globe } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { notify } from '@/lib/toast'
import { Button, Dialog, inputClass } from '@/components/ui'
import type { FileItem } from '@/types'
import type { CreatedShare, SharesState } from './useShares'

interface ShareDialogProps {
  item: FileItem
  shares: SharesState
  driveId?: string
  onClose: () => void
}

const expiryOptions = [
  { label: '1 hour', hours: 1 },
  { label: '24 hours', hours: 24 },
  { label: '7 days', hours: 24 * 7 },
  { label: 'Never', hours: undefined },
] as const

export function ShareDialog({ item, shares, driveId, onClose }: ShareDialogProps) {
  const [created, setCreated] = useState<CreatedShare | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const shareUrl = created ? new URL(created.url, window.location.origin).toString() : ''

  async function create(hours?: number) {
    setBusy(true)
    setError('')
    try {
      setCreated(await shares.createShare(item.id, item.name, hours, driveId))
    } catch (cause) {
      setError(errorMessage(cause, 'Unable to create share'))
    } finally {
      setBusy(false)
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      // A focused button's label change is not reliably re-announced.
      notify.success('Share link copied')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access is denied on insecure origins.
      notify.message('Copy the link manually', 'The browser blocked clipboard access.')
    }
  }

  return (
    <Dialog
      open
      // The token is shown once, so a stray Escape must not discard it.
      dismissable={!created && !busy}
      onOpenChange={next => { if (!next) onClose() }}
      title={`Share “${item.name}”`}
      description="Anyone with the link can view this file without signing in"
      footer={created ? <Button variant="primary" onClick={onClose}>Done</Button> : undefined}
    >
      {error && <p className="mb-3 text-sm text-vault-danger" role="alert">{error}</p>}

      {created ? (
        <div className="grid gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <input
              className={`${inputClass} font-vault-mono text-xs`}
              value={shareUrl}
              readOnly
              onFocus={event => event.target.select()}
              aria-label="Share link"
            />
            <Button variant="secondary" onClick={() => void copyLink()} className="shrink-0">
              {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="flex items-start gap-2 font-vault-mono text-xs text-vault-subtle">
            <Globe className="mt-px size-3.5 shrink-0" />
            {created.expiresAt
              ? `Expires ${new Date(created.expiresAt).toLocaleString()}.`
              : 'This link never expires.'} Revoke it any time from Shares.
          </p>
        </div>
      ) : (
        <fieldset className="grid gap-2" disabled={busy}>
          <legend className="mb-2 text-sm font-medium text-vault-ink">How long should the link work?</legend>
          <div className="grid grid-cols-2 gap-2">
            {expiryOptions.map(option => (
              <Button key={option.label} variant="secondary" onClick={() => void create(option.hours)}>
                {option.label}
              </Button>
            ))}
          </div>
        </fieldset>
      )}
    </Dialog>
  )
}
