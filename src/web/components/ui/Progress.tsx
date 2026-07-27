import { Progress as P } from 'radix-ui'
import { cn } from '@/lib/cn'

export function Progress({ value, label, className }: { value: number; label: string; className?: string }) {
  const clamped = Math.max(0, Math.min(100, value))
  return (
    <P.Root
      value={clamped}
      aria-label={label}
      className={cn('h-1 w-full overflow-hidden rounded-full bg-vault-paper-3', className)}
    >
      <P.Indicator
        className="h-full rounded-full bg-vault-accent transition-[width] duration-(--dur-ui) ease-out"
        style={{ width: `${clamped}%` }}
      />
    </P.Root>
  )
}
