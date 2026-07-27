import type { ReactNode } from 'react'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/cn'

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 font-vault-mono text-[0.625rem] uppercase tracking-[0.04em] [&_svg]:size-3',
  {
    variants: {
      tone: {
        neutral: 'border-vault-rule text-vault-subtle',
        success: 'border-vault-success-rule text-vault-success',
        accent: 'border-vault-accent/40 bg-vault-accent-soft text-vault-accent',
        warning: 'border-vault-warning/40 bg-vault-warning-soft text-vault-warning',
        danger: 'border-vault-danger-rule bg-vault-danger-soft text-vault-danger',
      },
    },
    defaultVariants: { tone: 'neutral' },
  }
)

export function Badge({ tone, className, children }: VariantProps<typeof badgeVariants> & { className?: string; children: ReactNode }) {
  return <span className={cn(badgeVariants({ tone }), className)}>{children}</span>
}
