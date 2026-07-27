import { CheckCircle2, LoaderCircle, X, XCircle } from 'lucide-react'
import { formatBytes } from '@/lib/format'
import { Button, Progress } from '@/components/ui'
import type { UploadTask } from './upload'

export function UploadTray({ uploads, onDismiss }: { uploads: UploadTask[]; onDismiss: () => void }) {
  if (uploads.length === 0) return null

  const done = uploads.filter(task => task.status === 'done').length
  const failed = uploads.filter(task => task.status === 'error').length
  const finished = done + failed === uploads.length
  const active = uploads.find(task => task.status === 'uploading' || task.status === 'processing')

  return (
    <section
      className="mb-4 overflow-hidden rounded-vault-sm border border-vault-rule bg-vault-surface"
      aria-label="Upload progress"
    >
      <header className="flex min-h-11 items-center gap-3 border-b border-vault-rule px-4 font-vault-mono text-xs text-vault-muted">
        <span aria-live="polite" aria-atomic="true">
          {finished
            ? `${done} uploaded${failed ? `, ${failed} failed` : ''}`
            : active?.status === 'processing'
              ? `Processing ${done + failed + 1} of ${uploads.length}`
              : `Uploading ${done + failed + 1} of ${uploads.length}`}
        </span>
        {finished && (
          <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={onDismiss} aria-label="Dismiss upload summary">
            <X />
          </Button>
        )}
      </header>

      <ul className="grid max-h-[min(24rem,50dvh)] gap-px overflow-y-auto bg-vault-rule">
        {uploads.map(task => (
          <li key={task.id} className="grid gap-1.5 bg-vault-surface px-4 py-2.5">
            <div className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{task.name}</span>
              {task.status === 'done' && <><CheckCircle2 className="size-4 shrink-0 text-vault-success" aria-hidden="true" /><span className="sr-only">Uploaded</span></>}
              {task.status === 'error' && <><XCircle className="size-4 shrink-0 text-vault-danger" aria-hidden="true" /><span className="sr-only">Failed</span></>}
              {task.status === 'uploading' && (
                <span className="shrink-0 font-vault-mono text-xs tabular-nums text-vault-subtle">
                  {formatBytes(task.loaded)} / {formatBytes(task.total)}
                </span>
              )}
              {task.status === 'processing' && (
                <span className="inline-flex shrink-0 items-center gap-1.5 font-vault-mono text-xs text-vault-subtle">
                  <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  Saving to storage
                </span>
              )}
            </div>
            {task.status === 'uploading' && (
              <Progress
                value={task.total ? (task.loaded / task.total) * 100 : 0}
                label={`Uploading ${task.name}`}
              />
            )}
            {task.status === 'processing' && (
              <Progress value={100} label={`Saving ${task.name} to storage`} className="animate-pulse motion-reduce:animate-none" />
            )}
            {task.status === 'error' && (
              <p className="font-vault-mono text-xs text-vault-danger">{task.error}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
