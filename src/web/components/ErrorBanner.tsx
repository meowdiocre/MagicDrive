import { AlertTriangle, RotateCw } from 'lucide-react'
import { Button } from './ui'

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      className="mb-6 flex items-center gap-3 rounded-vault-sm border border-vault-danger-rule bg-vault-danger-soft px-4 py-3 text-sm text-vault-danger"
      role="alert"
    >
      <AlertTriangle className="size-4.5 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && (
        <Button variant="ghost" size="sm" onClick={onRetry} className="shrink-0 text-vault-danger hover:bg-vault-danger/10 hover:text-vault-danger">
          <RotateCw /> Retry
        </Button>
      )}
    </div>
  )
}
