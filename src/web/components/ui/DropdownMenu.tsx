import type { ReactNode } from 'react'
import { DropdownMenu as M } from 'radix-ui'
import { cn } from '@/lib/cn'

export const DropdownMenu = M.Root
export const DropdownMenuTrigger = M.Trigger

export function DropdownMenuContent({ children, align = 'end' }: { children: ReactNode; align?: 'start' | 'center' | 'end' }) {
  return (
    <M.Portal>
      <M.Content
        align={align}
        sideOffset={4}
        collisionPadding={8}
        className="z-50 min-w-44 overflow-hidden rounded-vault-sm border border-vault-rule bg-vault-surface p-1 shadow-[0_0.5rem_0.5rem_var(--color-shadow)] data-[state=open]:animate-panel-in data-[state=closed]:animate-panel-out"
      >
        {children}
      </M.Content>
    </M.Portal>
  )
}

export function DropdownMenuItem({ children, onSelect, destructive, disabled }: {
  children: ReactNode
  onSelect?: () => void
  destructive?: boolean
  disabled?: boolean
}) {
  return (
    <M.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex min-h-10 cursor-pointer select-none items-center gap-2.5 rounded-vault-xs px-2.5 text-sm text-vault-ink outline-none data-highlighted:bg-vault-paper-2 data-disabled:pointer-events-none data-disabled:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-vault-subtle',
        destructive && 'text-vault-danger data-highlighted:bg-vault-danger-soft [&_svg]:text-vault-danger',
      )}
    >
      {children}
    </M.Item>
  )
}

export function DropdownMenuSeparator() {
  return <M.Separator className="my-1 h-px bg-vault-rule" />
}

export function DropdownMenuLabel({ children }: { children: ReactNode }) {
  return <M.Label className="px-2.5 py-1.5 font-vault-mono text-[0.625rem] uppercase tracking-[0.06em] text-vault-subtle">{children}</M.Label>
}
