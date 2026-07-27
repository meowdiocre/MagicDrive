import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { SpellDialog } from '@/features/auth/SpellDialog'
import { Button } from './ui'
import type { ButtonProps } from './ui'

interface SignInButtonProps extends Omit<ButtonProps, 'asChild' | 'children' | 'onClick'> {
  label?: string
  onSignedIn: () => void
}

/** An account is a username and a spell; no identity provider stands behind it. */
export function SignInButton({ label = 'Sign in', onSignedIn, ...props }: SignInButtonProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button {...props} onClick={() => setOpen(true)}>
        <Sparkles /> {label}
      </Button>
      <SpellDialog open={open} onClose={() => setOpen(false)} onSignedIn={onSignedIn} />
    </>
  )
}
