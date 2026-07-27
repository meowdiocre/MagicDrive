import { useState } from 'react'
import { HardDrive, Plus, Users } from 'lucide-react'
import { cn } from '@/lib/cn'
import { formatBytes } from '@/lib/format'
import { notify } from '@/lib/toast'
import { Button } from '@/components/ui'
import { EmptyState } from '@/components/EmptyState'
import { SignInButton } from '@/components/SignInButton'
import { ErrorBanner } from '@/components/ErrorBanner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { PromptDialog } from '@/components/PromptDialog'
import { AddStorageDialog } from './AddStorageDialog'
import { StorageCard } from './StorageCard'
import type { DrivesState } from './useDrives'
import type { DriveInfo, Session } from '@/types'

interface StorageViewProps {
  session: Session | null
  drives: DrivesState
  onSignedIn: () => void
}

export function StorageView({ session, drives, onSignedIn }: StorageViewProps) {
  const [adding, setAdding] = useState(false)
  const [renameTarget, setRenameTarget] = useState<DriveInfo | null>(null)
  const [removeTarget, setRemoveTarget] = useState<DriveInfo | null>(null)

  const connections = drives.items.filter(drive => !drive.is_virtual)
  const owned = connections.filter(drive => drive.is_owner)
  const contributed = session ? connections.filter(drive => !drive.is_owner) : connections
  const pool = drives.items.find(drive => drive.is_virtual)
  const poolName = pool?.name ?? 'the pool'
  const reporting = connections.filter(drive => drive.usage?.usedBytes !== null && drive.usage !== undefined && drive.usage !== null).length
  const splitGroups = Boolean(session && contributed.length > 0)

  return (
    <section className="w-full">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <h1 className="m-0 font-vault-display text-2xl font-semibold tracking-[-0.03em]">Storage</h1>
          <p className="mt-1 max-w-[62ch] text-sm text-vault-muted">Manage access and contribution to {poolName}.</p>
        </div>
        {session
          ? <Button variant="primary" size="sm" onClick={() => setAdding(true)}><Plus /> Connect storage</Button>
          : <SignInButton label="Sign in" variant="primary" size="sm" onSignedIn={onSignedIn} />}
      </header>

      {drives.error && <ErrorBanner message={drives.error} onRetry={() => void drives.refresh()} />}

      {pool?.usage && pool.usage.usedBytes !== null && connections.length > 0 && (
        <p className="mb-6 rounded-vault-sm border border-vault-rule bg-vault-surface px-4 py-3 font-vault-mono text-xs text-vault-muted">
          {poolName}: {formatBytes(pool.usage.usedBytes)} used
          {pool.usage.totalBytes !== null && ` of ${formatBytes(pool.usage.totalBytes)}`}
          {' '}· usage available for {reporting} of {connections.length} connection{connections.length === 1 ? '' : 's'}
        </p>
      )}

      {connections.length === 0 ? (
        <div className="rounded-vault-md border border-vault-rule bg-vault-surface">
          <EmptyState
            icon={HardDrive}
            title="No storage connected yet"
            description="Connect Google Drive, WebDAV, or S3 to get started."
            illustration
            action={session
              ? <Button variant="secondary" size="sm" onClick={() => setAdding(true)}><Plus /> Connect storage</Button>
              : <SignInButton label="Sign in" variant="secondary" size="sm" onSignedIn={onSignedIn} />}
          />
        </div>
      ) : (
        <div className={cn(
          'grid gap-6',
          splitGroups && 'xl:grid-cols-2 xl:items-start',
        )}>
          {session && (
            <div className="grid gap-3">
              <h2 className="font-vault-mono text-xs uppercase tracking-[0.08em] text-vault-subtle">
                Yours · {owned.length}
              </h2>
              {owned.length === 0 ? (
                <div className="rounded-vault-md border border-dashed border-vault-rule-strong p-4 text-sm text-vault-muted">
                  You have not connected any storage yet.
                </div>
              ) : owned.map(drive => (
                <StorageCard
                  key={drive.id}
                  drive={drive}
                  onRename={() => setRenameTarget(drive)}
                  onRemove={() => setRemoveTarget(drive)}
                />
              ))}
            </div>
          )}

          {contributed.length > 0 && (
            <div className="grid gap-3">
              <h2 className="flex items-center gap-2 font-vault-mono text-xs uppercase tracking-[0.08em] text-vault-subtle">
                <Users className="size-3.5" /> Contributed by others · {contributed.length}
              </h2>
              {contributed.map(drive => (
                <StorageCard key={drive.id} drive={drive} />
              ))}
            </div>
          )}
        </div>
      )}

      <AddStorageDialog open={adding} drives={drives} onClose={() => setAdding(false)} />

      <PromptDialog
        open={Boolean(renameTarget)}
        key={renameTarget?.id ?? 'rename-storage'}
        title="Rename storage"
        description={renameTarget?.name}
        label="Display name"
        initialValue={renameTarget?.name ?? ''}
        submitLabel="Rename"
        onSubmit={async name => {
          if (!renameTarget || name === renameTarget.name) return
          await drives.renameDrive(renameTarget.id, name)
          notify.success(`Renamed to “${name}”`)
        }}
        onClose={() => setRenameTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(removeTarget)}
        title="Disconnect storage"
        message={removeTarget
          ? `Disconnecting “${removeTarget.name}” removes it from MagicDrive. Files in the provider remain, but existing share links stop working.`
          : ''}
        confirmLabel="Disconnect"
        destructive
        onConfirm={async () => {
          if (!removeTarget) return
          try {
            await drives.deleteDrive(removeTarget.id)
            notify.success(`Disconnected ${removeTarget.name}`)
          } catch (cause) {
            notify.error(cause, 'Unable to disconnect storage')
          }
        }}
        onClose={() => setRemoveTarget(null)}
      />
    </section>
  )
}
