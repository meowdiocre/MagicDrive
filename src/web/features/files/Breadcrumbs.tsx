import { useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import { SEARCH_PATH } from './useFiles'

export function Breadcrumbs({ path, onNavigate }: { path: string; onNavigate: (path: string) => void }) {
  const crumbs = useMemo(() => {
    if (path === SEARCH_PATH) return [{ label: 'Root', value: '/' }, { label: SEARCH_PATH, value: path }]
    const parts = path.split('/').filter(Boolean)
    return [
      { label: 'Root', value: '/' },
      ...parts.map((part, index) => ({ label: part, value: `/${parts.slice(0, index + 1).join('/')}` })),
    ]
  }, [path])

  return (
    <nav
      className="flex min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap font-vault-mono text-xs text-vault-subtle"
      aria-label="Breadcrumb"
    >
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1
        return (
          <span className="flex shrink-0 items-center gap-1" key={crumb.value}>
            {index > 0 && <ChevronRight className="size-3 shrink-0 text-vault-rule-strong" aria-hidden="true" />}
            <button
              className="rounded-vault-xs px-1 py-0.5 text-inherit outline-offset-1 hover:text-vault-accent disabled:pointer-events-none disabled:text-vault-ink"
              onClick={() => onNavigate(crumb.value)}
              disabled={isLast}
              aria-current={isLast ? 'page' : undefined}
            >
              {crumb.label}
            </button>
          </span>
        )
      })}
    </nav>
  )
}
