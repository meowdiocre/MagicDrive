import type { ReactNode, RefObject } from 'react'
import { Dialog as D } from 'radix-ui'

export function Sheet({ open, onOpenChange, title, returnFocusTo, children }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  returnFocusTo?: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-vault-scrim data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
        <D.Content
          aria-label={title}
          onCloseAutoFocus={event => {
            const target = returnFocusTo?.current
            if (!target) return
            event.preventDefault()
            setTimeout(() => target.focus(), 0)
          }}
          className="fixed inset-y-0 left-0 z-50 flex w-[min(18rem,82vw)] flex-col overflow-y-auto border-r border-vault-rule bg-vault-paper-2 px-5 py-6 shadow-[0.25rem_0_0.5rem_var(--color-shadow)] outline-none data-[state=open]:animate-sheet-in data-[state=closed]:animate-sheet-out"
        >
          <D.Title className="sr-only">{title}</D.Title>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
