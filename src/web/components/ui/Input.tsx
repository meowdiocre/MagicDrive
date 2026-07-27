import { forwardRef, useId } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

export const inputClass = 'h-11 w-full min-w-0 rounded-vault-sm border border-vault-rule-strong bg-vault-paper px-3 text-sm text-vault-ink outline-none transition-[border-color,box-shadow] duration-[var(--dur-ui)] placeholder:text-vault-subtle hover:border-vault-ink focus:border-vault-accent focus:ring-2 focus:ring-vault-accent-soft disabled:opacity-50'

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  hint?: ReactNode
  error?: string
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(
  ({ label, hint, error, className, id, ...props }, ref) => {
    const generatedId = useId()
    const inputId = id ?? generatedId
    const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined

    return (
      <div className="grid gap-1.5">
        <label htmlFor={inputId} className="text-sm font-medium text-vault-ink">{label}</label>
        <input
          ref={ref}
          id={inputId}
          className={cn(inputClass, error && 'border-vault-danger focus:border-vault-danger focus:ring-vault-danger-soft', className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...props}
        />
        {error
          ? <p id={`${inputId}-error`} className="font-vault-mono text-xs text-vault-danger">{error}</p>
          : hint && <p id={`${inputId}-hint`} className="font-vault-mono text-xs text-vault-subtle">{hint}</p>}
      </div>
    )
  }
)
Field.displayName = 'Field'
