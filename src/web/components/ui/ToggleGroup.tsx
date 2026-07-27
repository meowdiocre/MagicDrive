import type { ReactNode } from 'react'
import { ToggleGroup as TG } from 'radix-ui'

interface ToggleGroupProps<T extends string> {
  value: T
  onValueChange: (value: T) => void
  label: string
  options: { value: T; label: string; icon: ReactNode }[]
}

export function ToggleGroup<T extends string>({ value, onValueChange, label, options }: ToggleGroupProps<T>) {
  return (
    <TG.Root
      type="single"
      value={value}
      onValueChange={next => { if (next) onValueChange(next as T) }}
      aria-label={label}
      className="flex shrink-0 rounded-vault-sm border border-vault-rule-strong p-1"
    >
      {options.map(option => (
        <TG.Item
          key={option.value}
          value={option.value}
          aria-label={option.label}
          className="grid size-9 place-items-center rounded-vault-xs bg-transparent text-vault-subtle outline-offset-1 transition-colors duration-(--dur-fast) hover:text-vault-ink data-[state=on]:bg-vault-paper-3 data-[state=on]:text-vault-ink max-[60rem]:size-11 [&_svg]:size-4.5"
        >
          {option.icon}
        </TG.Item>
      ))}
    </TG.Root>
  )
}
