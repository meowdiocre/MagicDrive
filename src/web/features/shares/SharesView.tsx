import { useState } from 'react'
import { Link2, Share2, Trash2, Users } from 'lucide-react'
import { formatDate } from '@/lib/format'
import { notify } from '@/lib/toast'
import { Badge, Button, Skeleton } from '@/components/ui'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import type { ShareItem, SharesState } from './useShares'

export function SharesView({ shares }: { shares: SharesState }) {
  const [revokeTarget, setRevokeTarget] = useState<ShareItem | null>(null)

  return (
    <section className="w-full">
      <header className="mb-6">
        <h1 className="m-0 font-vault-display text-2xl font-semibold tracking-[-0.03em]">Share links</h1>
        <p className="mt-1 max-w-[62ch] text-sm text-vault-muted">
          Anyone with a share link can download its file without signing in. Revoke a link to disable it.
        </p>
      </header>

      {shares.error && <ErrorBanner message={shares.error} onRetry={() => void shares.refresh()} />}

      <div className="overflow-hidden rounded-vault-md border border-vault-rule bg-vault-surface">
        {shares.loading ? (
          <div className="grid gap-px bg-vault-rule">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="flex items-center gap-3 bg-vault-surface px-4 py-3.5">
                <Skeleton className="size-9 rounded-vault-sm" />
                <Skeleton className="h-3 w-48" />
              </div>
            ))}
          </div>
        ) : shares.items.length === 0 ? (
          <EmptyState
            icon={Share2}
            title="No share links yet"
            description="Share a file to create a link. Revoke it here when access is no longer needed."
          />
        ) : (
          <>
            <div className="flex min-h-10 items-center justify-between border-b border-vault-rule px-4 font-vault-mono text-xs text-vault-muted">
              <span>{shares.items.length} link{shares.items.length === 1 ? '' : 's'}</span>
            </div>
            <ul>
              {shares.items.map(share => {
                const expired = Boolean(share.expires_at && new Date(share.expires_at).getTime() < Date.now())
                return (
                  <li
                    key={share.id}
                    className="flex min-h-14 items-center gap-3 border-b border-vault-rule px-4 last:border-b-0 hover:bg-vault-paper-2 max-[40rem]:flex-wrap max-[40rem]:py-3"
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-vault-sm bg-vault-accent-soft text-vault-accent">
                      <Link2 className="size-4.5" />
                    </span>

                    <span className="grid min-w-0 flex-1">
                      <strong className="truncate text-sm font-medium">{share.name}</strong>
                      <span className="font-vault-mono text-xs text-vault-subtle">
                        {share.drive_name} · created {formatDate(share.created_at)}
                        {share.expires_at
                          ? ` · ${expired ? 'expired' : 'expires'} ${formatDate(share.expires_at)}`
                          : ' · never expires'}
                      </span>
                    </span>

                    {!share.mine && (
                      <Badge tone="warning">
                        <Users /> created by another member
                      </Badge>
                    )}
                    <Badge tone={expired ? 'neutral' : 'success'}>{expired ? 'expired' : 'active'}</Badge>

                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setRevokeTarget(share)}
                      aria-label={`Revoke share for ${share.name}`}
                      className="hover:bg-vault-danger-soft hover:text-vault-danger"
                    >
                      <Trash2 />
                    </Button>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        title="Revoke share link"
        message={revokeTarget
          ? `Revoke the public link to “${revokeTarget.name}”? Anyone using it will lose access immediately.`
          : ''}
        confirmLabel="Revoke"
        destructive
        onConfirm={async () => {
          if (!revokeTarget) return
          try {
            await shares.deleteShare(revokeTarget.id)
            notify.success('Share link revoked')
          } catch (cause) {
            notify.error(cause, 'Unable to revoke link')
            void shares.refresh()
          }
        }}
        onClose={() => setRevokeTarget(null)}
      />
    </section>
  )
}
