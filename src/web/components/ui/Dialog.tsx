import type { ReactNode } from 'react'
import { Dialog as D } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from './Button'

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  className?: string
  children: ReactNode
  footer?: ReactNode
  onOpenAutoFocus?: (event: Event) => void
  dismissable?: boolean
}

export function Dialog({
  open, onOpenChange, title, description, className,
  children, footer, onOpenAutoFocus, dismissable = true,
}: DialogProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-vault-scrim backdrop-blur-[2px] data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
        <D.Content
          onOpenAutoFocus={onOpenAutoFocus}
          onEscapeKeyDown={event => { if (!dismissable) event.preventDefault() }}
          onPointerDownOutside={event => { if (!dismissable) event.preventDefault() }}
          onInteractOutside={event => { if (!dismissable) event.preventDefault() }}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-vault-md border border-vault-rule bg-vault-surface shadow-[0_0.5rem_0.5rem_var(--color-shadow)] outline-none data-[state=open]:animate-panel-in data-[state=closed]:animate-panel-out',
            className,
          )}
        >
          <header className="flex shrink-0 items-start gap-3 border-b border-vault-rule px-5 py-4">
            <div className="min-w-0 flex-1">
              <D.Title className="truncate text-base font-semibold text-vault-ink">{title}</D.Title>
              {description && (
                <D.Description className="mt-0.5 font-vault-mono text-xs text-vault-subtle">{description}</D.Description>
              )}
            </div>
            <D.Close asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close dialog"
                className="-mr-1 -mt-1"
                disabled={!dismissable}
              >
                <X />
              </Button>
            </D.Close>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

          {footer && (
            <footer className="flex shrink-0 justify-end gap-2 border-t border-vault-rule px-5 py-4 max-[26rem]:grid max-[26rem]:grid-cols-2 max-[40rem]:pb-[max(1rem,env(safe-area-inset-bottom))] [&>*]:min-w-0">
              {footer}
            </footer>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

export const DialogDescription = D.Description
