import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

function EmptyGlyph({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="grid size-12 place-items-center rounded-vault-md border border-vault-rule bg-vault-paper-2 text-vault-accent">
      <Icon className="size-5" />
    </span>
  )
}

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?: ReactNode
  /** Swaps the glyph for the brand illustration on the app's landing moments. */
  illustration?: boolean
}

export function EmptyState({ icon, title, description, action, illustration = false }: EmptyStateProps) {
  return (
    <div className="grid place-items-center px-6 py-14 text-center">
      {illustration
        ? <img
            src="/brand/hero.webp"
            alt=""
            width={180}
            height={261}
            className="mb-2 h-auto w-45 max-w-[45vw] object-contain dark:filter-[drop-shadow(0_0_1px_var(--color-muted))_drop-shadow(0_0_10px_color-mix(in_oklch,var(--color-accent)_35%,transparent))]"
          />
        : <EmptyGlyph icon={icon} />}
      <h2 className="mb-1.5 mt-4 text-lg font-semibold">{title}</h2>
      <p className="mb-5 max-w-[42ch] text-sm text-vault-muted">{description}</p>
      {action}
    </div>
  )
}
