import { useEffect, useState } from 'react'
import { Database, RotateCcw, TriangleAlert } from 'lucide-react'
import { apiGet, errorMessage } from '@/api/client'
import { formatBytes } from '@/lib/format'
import { Button, Progress, Skeleton } from '@/components/ui'
import type { CapacityInfo } from '@/types'

export function CapacityPanel({ driveId, refreshKey }: { driveId: string; refreshKey: number }) {
  const [capacity, setCapacity] = useState<CapacityInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let current = true
    setLoading(true)
    setError('')
    apiGet<CapacityInfo>(`/api/capacity?drive=${encodeURIComponent(driveId)}`, 'Unable to load capacity')
      .then(result => { if (current) setCapacity(result) })
      .catch(cause => { if (current) setError(errorMessage(cause, 'Unable to load capacity')) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [driveId, refreshKey, retry])

  const percent =
    capacity &&
    capacity.usedBytes !== null &&
    capacity.totalBytes !== null &&
    capacity.totalBytes > 0
      ? (capacity.usedBytes / capacity.totalBytes) * 100
      : null
  const storageCount = capacity
    ? capacity.knownStorages + capacity.unknownStorages + capacity.unavailableStorages
    : 0
  const heading = driveId === 'global' ? 'Cauldron capacity' : 'MagicVault capacity'

  return (
    <aside className="self-start rounded-vault-md border border-vault-rule bg-vault-surface p-4" aria-label="Connected storage capacity" aria-busy={loading}>
      <header className="mb-4 flex items-center gap-2">
        <Database className="size-4 text-vault-accent" aria-hidden="true" />
        <h2 className="m-0 text-sm font-semibold text-vault-ink">{heading}</h2>
      </header>

      {loading ? (
        <div className="grid gap-3" aria-hidden="true">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-1 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : error ? (
        <div className="grid gap-3">
          <p className="flex items-start gap-2 text-sm text-vault-warning" role="alert">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {error}
          </p>
          <Button variant="secondary" size="sm" onClick={() => setRetry(value => value + 1)}>
            <RotateCcw /> Retry
          </Button>
        </div>
      ) : capacity && (
        <div className="grid gap-4">
          <div className="grid gap-2">
            <p className="text-lg font-semibold tabular-nums text-vault-ink">
              {formatBytes(capacity.usedBytes, undefined, 'Unknown')} <span className="text-sm font-normal text-vault-muted">of {formatBytes(capacity.totalBytes, undefined, 'Unknown')}</span>
            </p>
            {percent !== null && <Progress value={percent} label="Connected storage used" />}
            <p className="font-vault-mono text-xs text-vault-subtle">{formatBytes(capacity.freeBytes, undefined, 'Unknown')} free</p>
          </div>

          <dl className="grid grid-cols-2 gap-3 border-t border-vault-rule pt-3">
            <div>
              <dt className="font-vault-mono text-xs text-vault-subtle">Contributors</dt>
              <dd className="mt-0.5 text-sm font-semibold tabular-nums text-vault-ink">{storageCount}</dd>
            </div>
            {capacity.managedBytes !== null && (
              <div>
                <dt className="font-vault-mono text-xs text-vault-subtle">Vault data</dt>
                <dd className="mt-0.5 text-sm font-semibold tabular-nums text-vault-ink">{formatBytes(capacity.managedBytes, undefined, 'Unknown')}</dd>
              </div>
            )}
          </dl>

          {(capacity.unknownStorages > 0 || capacity.unavailableStorages > 0) && (
            <p className="font-vault-mono text-xs leading-relaxed text-vault-subtle">
              {capacity.unknownStorages > 0 && `${capacity.unknownStorages} limit unknown`}
              {capacity.unknownStorages > 0 && capacity.unavailableStorages > 0 && ' · '}
              {capacity.unavailableStorages > 0 && `${capacity.unavailableStorages} unavailable`}
            </p>
          )}

        </div>
      )}
    </aside>
  )
}
