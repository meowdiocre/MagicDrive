import { cn } from '@/lib/cn'

export function Brand({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5 text-vault-ink', className)}>
      <BrandMark className="size-10" />
      <span className="whitespace-nowrap font-vault-display text-xl font-bold leading-none tracking-[-0.02em] [font-kerning:normal]">
        Magic<span className="text-vault-accent">Drive</span>
      </span>
    </div>
  )
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      src="/brand/mark.png"
      alt=""
      width={36}
      height={36}
      className={cn('size-9 shrink-0 object-contain', className)}
    />
  )
}
