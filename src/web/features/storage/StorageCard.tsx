import { Cloud, EyeOff, Globe2, HardDrive, Layers, Link2, Lock, LockKeyhole, Pencil, Trash2, TriangleAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { formatBytes, formatDate } from '@/lib/format'
import { Avatar, Badge, Button, Progress, Tooltip } from '@/components/ui'
import type { DriveInfo } from '@/types'

const providers: Record<string, { label: string; icon: LucideIcon }> = {
  google: { label: 'Google Drive', icon: Cloud },
  webdav: { label: 'WebDAV', icon: Link2 },
  s3: { label: 'S3-compatible', icon: HardDrive },
  global: { label: 'Pooled view', icon: Layers },
}

function UsageLine({ drive }: { drive: DriveInfo }) {
  if (drive.health && !drive.health.ok) {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 font-vault-mono text-xs text-vault-warning">
        <TriangleAlert className="size-3.5" /> unreachable: {drive.health.message ?? 'connection failed'}
      </p>
    )
  }
  const usage = drive.usage
  if (!usage || usage.usedBytes === null) return null
  // A zero total is "no quota reported", not a full disk: dividing would show 100%.
  if (!usage.totalBytes) {
    return <p className="mt-1.5 font-vault-mono text-xs text-vault-subtle">{formatBytes(usage.usedBytes)} used</p>
  }
  const percent = (usage.usedBytes / usage.totalBytes) * 100
  return (
    <div className="mt-2 grid max-w-72 gap-1">
      <Progress value={percent} label={`${drive.name} storage used`} />
      <p className="font-vault-mono text-xs text-vault-subtle">
        {formatBytes(usage.usedBytes)} of {formatBytes(usage.totalBytes)} used
      </p>
    </div>
  )
}

function AccessBadge({ drive }: { drive: DriveInfo }) {
  if (drive.access_mode === 'private') return <Badge tone="neutral"><EyeOff /> private</Badge>
  if (drive.access_mode === 'protected') {
    return <Badge tone="warning"><LockKeyhole /> {drive.locked ? 'locked' : 'protected'}</Badge>
  }
  return <Badge tone="accent"><Globe2 /> public</Badge>
}

interface StorageCardProps {
  drive: DriveInfo
  onRename?: () => void
  onRemove?: () => void
}

export function StorageCard({ drive, onRename, onRemove }: StorageCardProps) {
  const provider = providers[drive.provider] ?? { label: drive.provider, icon: HardDrive }
  const ProviderIcon = provider.icon

  return (
    <article className="flex items-center gap-4 rounded-vault-md border border-vault-rule bg-vault-surface p-4 transition-colors duration-(--dur-fast) hover:border-vault-rule-strong max-[40rem]:flex-wrap">
      <span className="grid size-10 shrink-0 place-items-center rounded-vault-sm border border-vault-rule bg-vault-paper-2 text-vault-accent">
        <ProviderIcon className="size-5" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 truncate text-base font-semibold">{drive.name}</h2>
          {drive.is_owner
            ? <Badge tone="success">yours</Badge>
            : <Badge tone="neutral"><Lock /> read-only</Badge>}
          {!drive.is_virtual && <AccessBadge drive={drive} />}
          {!drive.is_virtual && drive.pool_contributor && <Badge tone="accent"><Layers /> contributor</Badge>}
        </div>
        <p className="mt-0.5 truncate text-sm text-vault-muted">{drive.provider_label ?? provider.label}</p>
        <p className="mt-0.5 font-vault-mono text-xs text-vault-subtle">
          added {formatDate(drive.created_at)}
          {!drive.is_owner && ' · read-only'}
        </p>
        <UsageLine drive={drive} />
      </div>

      {!drive.is_owner && (
        <Tooltip label={`Owned by ${drive.owner_name}`}>
          <span
            className="flex shrink-0 items-center gap-2 max-[40rem]:order-last"
            role="group"
            tabIndex={0}
            aria-label={`Owned by ${drive.owner_name}`}
          >
            <Avatar name={drive.owner_name} />
            <span aria-hidden="true" className="truncate text-sm text-vault-muted max-[48rem]:hidden">{drive.owner_name}</span>
          </span>
        </Tooltip>
      )}

      {onRename && (
        <Button variant="ghost" size="icon" onClick={onRename} aria-label={`Rename ${drive.name}`} className="shrink-0">
          <Pencil />
        </Button>
      )}
      {onRemove && (
        <Button variant="ghost" size="icon" onClick={onRemove} aria-label={`Disconnect ${drive.name}`} className="shrink-0 hover:bg-vault-danger-soft hover:text-vault-danger">
          <Trash2 />
        </Button>
      )}
    </article>
  )
}
