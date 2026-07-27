import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Copy, RefreshCw, TriangleAlert } from 'lucide-react'
import { apiGet, apiPost } from '@/api/client'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/cn'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { Button, Dialog, Field, inputClass } from '@/components/ui'
import { conjureSpell } from './spell'
import type { Session } from '@/types'

type Mode = 'login' | 'register'

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: 'login', label: 'Sign in', hint: 'Use your existing spell.' },
  { value: 'register', label: 'Create account', hint: 'Choose a username and save your spell.' },
]

interface SpellDialogProps {
  open: boolean
  onClose: () => void
  onSignedIn: () => void
}

export function SpellDialog({ open, onClose, onSignedIn }: SpellDialogProps) {
  const [mode, setMode] = useState<Mode>('login')
  const [spell, setSpell] = useState('')
  const [username, setUsername] = useState('')
  const [invite, setInvite] = useState('')
  const [inviteRequired, setInviteRequired] = useState(false)
  const [own, setOwn] = useState(false)
  const { busy, error, setError, run } = useAsyncAction('Unable to continue')

  useEffect(() => {
    if (!open) return
    apiGet<{ invite: boolean }>('/api/health', 'Unable to check registration settings')
      .then(health => setInviteRequired(health.invite))
      .catch(() => setInviteRequired(false))
  }, [open])

  function switchMode(next: Mode) {
    setMode(next)
    setError('')
    setOwn(false)
    setSpell(next === 'register' ? conjureSpell() : '')
  }

  function close() {
    setMode('login')
    setSpell('')
    setUsername('')
    setInvite('')
    setOwn(false)
    setError('')
    onClose()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const entered = await run(async () => {
      const body = mode === 'login' ? { spell } : { spell, username, invite }
      await apiPost<{ user: Session }>(
        `/api/auth/${mode}`,
        body,
        mode === 'login' ? 'Unable to sign in' : 'Unable to create account',
      )
      notify.success(mode === 'login' ? 'Signed in' : 'Account created')
    })
    if (entered) {
      onSignedIn()
      close()
    }
  }

  async function copySpell() {
    try {
      await navigator.clipboard.writeText(spell)
      notify.success('Spell copied')
    } catch {
      notify.error(null, 'Could not copy. Select it and copy by hand.')
    }
  }

  const ready = mode === 'login' ? spell.trim().length > 0 : spell.trim().length > 0 && username.trim().length > 0

  return (
    <Dialog
      open={open}
      onOpenChange={next => { if (!next) close() }}
      dismissable={!busy}
      title="Sign in or create an account"
      description="Use a spell to sign in. No email is required."
      className="w-[min(32rem,calc(100vw-2rem))]"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="primary" form="spell-form" type="submit" disabled={busy || !ready}>
            {busy ? (mode === 'login' ? 'Signing in...' : 'Creating account...') : mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
        </>
      }
    >
      <form id="spell-form" className="grid gap-4" onSubmit={submit}>
        <div className="grid grid-cols-2 gap-2">
          {MODES.map(entry => (
            <button
              key={entry.value}
              type="button"
              aria-pressed={mode === entry.value}
              onClick={() => switchMode(entry.value)}
              className={cn(
                'flex min-h-16 flex-col items-start justify-center gap-1 rounded-vault-sm border border-vault-rule bg-vault-paper px-3 text-left text-sm transition-colors duration-(--dur-fast) hover:border-vault-rule-strong',
                mode === entry.value && 'border-vault-accent bg-vault-accent-soft text-vault-accent',
              )}
            >
              <span className="font-medium">{entry.label}</span>
              <span className="font-vault-mono text-xs text-vault-subtle">{entry.hint}</span>
            </button>
          ))}
        </div>

        {mode === 'register' && (
          <Field
            label="Username"
            value={username}
            onChange={event => setUsername(event.target.value.toLowerCase())}
            placeholder="cinderquill"
            hint="3–24 characters: letters, digits, hyphen or underscore."
            autoComplete="username"
            spellCheck={false}
            maxLength={24}
            required
          />
        )}

        {mode === 'login' || own ? (
          <Field
            label={mode === 'login' ? 'Your spell' : 'Your own spell'}
            value={spell}
            onChange={event => setSpell(event.target.value)}
            placeholder="ember-thistle-lantern-quill-moth-cinder-bramble"
            hint={mode === 'login'
              ? 'Spacing, hyphens and capitals do not matter.'
              : 'At least 16 characters and 3 words.'}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            spellCheck={false}
            className="font-vault-mono"
            required
          />
        ) : (
          <div className="grid gap-2">
            <span className="text-sm font-medium text-vault-ink">Your spell</span>
            <p className={cn(inputClass, 'flex h-auto min-h-11 items-center break-all py-2.5 font-vault-mono leading-relaxed')}>
              {spell}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => setSpell(conjureSpell())}>
                <RefreshCw /> Generate another
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void copySpell()}>
                <Copy /> Copy
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setOwn(true); setSpell('') }}>
                Use my own
              </Button>
            </div>
          </div>
        )}

        {mode === 'register' && inviteRequired && (
          <Field
            label="Invite code"
            value={invite}
            onChange={event => setInvite(event.target.value)}
            hint="Ask the administrator for an invite code."
            autoComplete="off"
            spellCheck={false}
            required
          />
        )}

        {mode === 'register' && (
          <p className="flex items-start gap-2 rounded-vault-sm border border-vault-warning/40 bg-vault-warning-soft px-3 py-2.5 text-sm text-vault-ink">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-vault-warning" />
            <span>
              Save this spell before continuing. It is the only way to sign in; there is no email recovery
              or reset option.
            </span>
          </p>
        )}

        {mode === 'login' && (
          <p className="flex items-start gap-2 font-vault-mono text-xs text-vault-subtle">
            Sign in to connect storage. Browsing and downloads are public.
          </p>
        )}

        {error && <p className="text-sm text-vault-danger" role="alert">{error}</p>}
      </form>
    </Dialog>
  )
}
