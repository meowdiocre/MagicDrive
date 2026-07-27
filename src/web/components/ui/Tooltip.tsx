import type { ReactNode } from 'react'
import { Tooltip as T } from 'radix-ui'

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <T.Provider delayDuration={400} skipDelayDuration={200}>{children}</T.Provider>
}

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          sideOffset={6}
          collisionPadding={8}
          className="z-50 rounded-vault-xs border border-vault-rule bg-vault-ink px-2 py-1 font-vault-mono text-[0.6875rem] text-vault-paper shadow-[0_0.25rem_0.5rem_var(--color-shadow)] data-[state=delayed-open]:animate-fade-in data-[state=closed]:animate-fade-out"
        >
          {label}
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}
