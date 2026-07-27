import type { ReactNode } from 'react'
import { Select as S } from 'radix-ui'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'

interface SelectProps {
  value: string
  onValueChange: (value: string) => void
  label: string
  className?: string
  children: ReactNode
}

export function Select({ value, onValueChange, label, className, children }: SelectProps) {
  return (
    <S.Root value={value} onValueChange={onValueChange}>
      <S.Trigger
        aria-label={label}
        className={cn(
          'inline-flex min-h-11 max-w-[16rem] items-center gap-2 rounded-vault-sm border border-vault-rule-strong bg-vault-surface px-3 text-sm text-vault-ink outline-offset-2 transition-colors duration-(--dur-ui) hover:border-vault-ink data-[state=open]:border-vault-accent',
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left"><S.Value /></span>
        <S.Icon><ChevronDown className="size-4 shrink-0 text-vault-subtle" /></S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 max-h-[min(20rem,var(--radix-select-content-available-height))] w-max min-w-[max(var(--radix-select-trigger-width),16rem)] max-w-[min(26rem,calc(100vw-2rem))] overflow-hidden rounded-vault-sm border border-vault-rule bg-vault-surface shadow-[0_0.5rem_0.5rem_var(--color-shadow)] data-[state=open]:animate-panel-in data-[state=closed]:animate-panel-out"
        >
          <S.Viewport className="p-1">{children}</S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  )
}

export function SelectItem({ value, children, hint }: { value: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <S.Item
      value={value}
      className="flex min-h-11 cursor-pointer select-none items-center gap-2.5 rounded-vault-xs px-2.5 text-sm text-vault-ink outline-none data-highlighted:bg-vault-paper-2 data-[state=checked]:font-semibold"
    >
      <span className="grid size-4 shrink-0 place-items-center">
        <S.ItemIndicator><Check className="size-4 text-vault-accent" /></S.ItemIndicator>
      </span>
      <span className="min-w-0 flex-1 truncate">
        <S.ItemText>{children}</S.ItemText>
      </span>
      {hint && <span className="shrink-0">{hint}</span>}
    </S.Item>
  )
}
