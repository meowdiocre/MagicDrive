import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'
import { Slot } from 'radix-ui'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/cn'

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-vault-sm border font-semibold no-underline outline-offset-2 transition-[background-color,border-color,color,transform,opacity] duration-[var(--dur-ui)] ease-[var(--ease-out)] active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-[1.125rem] [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'border-transparent bg-vault-ink text-vault-paper hover:bg-vault-ink-hover',
        secondary: 'border-vault-rule-strong bg-transparent text-vault-ink hover:border-vault-ink hover:bg-vault-paper-2',
        ghost: 'border-transparent bg-transparent text-vault-muted hover:bg-vault-paper-3 hover:text-vault-ink',
        danger: 'border-transparent bg-vault-danger text-vault-accent-ink hover:opacity-90',
        accent: 'border-transparent bg-vault-accent text-vault-accent-ink hover:opacity-90',
      },
      size: {
        md: 'min-h-11 px-5 text-sm',
        sm: 'min-h-9 px-3 text-sm max-[60rem]:min-h-11',
        icon: 'size-11 p-0 max-[60rem]:size-11',
        'icon-sm': 'size-9 p-0 max-[60rem]:size-11',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  }
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Component = asChild ? Slot.Root : 'button'
    return (
      <Component
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        type={asChild ? undefined : (type ?? 'button')}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'
