import { useEffect, useRef } from 'react'
import type { FormEvent, RefObject } from 'react'
import { Menu, Search, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui'

interface TopBarProps {
  onOpenNav: () => void
  menuButtonRef: RefObject<HTMLButtonElement | null>
  value: string
  onChange: (value: string) => void
  onSubmit: (event: FormEvent) => void
  onClear: () => void
  searching: boolean
  invalid: boolean
}

export function TopBar({ onOpenNav, menuButtonRef, value, onChange, onSubmit, onClear, searching, invalid }: TopBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      // Stealing focus to search would break an open dialog's focus trap.
      const layerOpen = document.querySelector('[role="dialog"],[role="menu"]') !== null
      if (event.key === '/' && !typing && !layerOpen) {
        event.preventDefault()
        inputRef.current?.focus()
      }
      if (event.key === 'Escape' && document.activeElement === inputRef.current) {
        inputRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <header className="sticky top-0 z-20 flex min-h-14 items-center gap-3 border-b border-vault-rule bg-vault-surface/90 px-6 backdrop-blur-md max-[60rem]:px-4">
      <Button
        ref={menuButtonRef}
        variant="ghost"
        size="icon-sm"
        className="hidden max-[60rem]:inline-flex"
        aria-label="Open navigation"
        onClick={onOpenNav}
      >
        <Menu />
      </Button>

      <form
        className={cn(
          'flex h-10 min-w-0 max-w-lg flex-1 items-center gap-2 rounded-vault-sm border border-vault-rule bg-vault-paper px-2.5 text-vault-subtle transition-[border-color,box-shadow] duration-(--dur-ui) hover:border-vault-rule-strong focus-within:border-vault-accent focus-within:ring-2 focus-within:ring-vault-accent-soft',
          invalid && 'border-vault-danger focus-within:border-vault-danger focus-within:ring-vault-danger-soft',
        )}
        onSubmit={onSubmit}
        role="search"
      >
        <Search className="size-4 shrink-0" aria-hidden="true" />
        <input
          ref={inputRef}
          className="h-full w-full min-w-0 bg-transparent text-sm text-vault-ink outline-none placeholder:text-vault-subtle disabled:opacity-60"
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder="Search this storage"
          aria-label="Search files in the active storage"
          minLength={2}
          // Not `disabled`: that blurs the focused field and collapses the soft keyboard.
          readOnly={searching}
          aria-busy={searching}
          type="search"
        />
        {value ? (
          <Button variant="ghost" size="icon-sm" className="-mr-1 size-7" onClick={onClear} aria-label="Clear search">
            <X className="size-3.5" />
          </Button>
        ) : (
          <kbd className="shrink-0 rounded-vault-xs border border-vault-rule px-1.5 font-vault-mono text-[0.625rem] text-vault-subtle max-[40rem]:hidden">
            /
          </kbd>
        )}
      </form>

      <span className="ml-auto font-vault-mono text-xs text-vault-subtle max-[48rem]:hidden" aria-live="polite">
        {searching ? 'Searching...' : ''}
      </span>
    </header>
  )
}
