import { cn } from '@/lib/cn'

export function Skeleton({ className }: { className?: string }) {
  return <span className={cn('block animate-shimmer rounded-vault-xs bg-vault-paper-3', className)} />
}
