import { useEffect, useState } from 'react'
import { Dialog as D } from 'radix-ui'
import { Download, FileQuestion, Share2, X } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { formatBytes, formatDate } from '@/lib/format'
import { Button, Skeleton } from '@/components/ui'
import { fileUrl } from './fileUrl'
import { previewKind } from './previewKind'
import { readTextPreview, TEXT_PREVIEW_LIMIT } from './readTextPreview'
import type { FileItem } from '@/types'

interface PreviewModalProps {
  item: FileItem
  driveId?: string
  onClose: () => void
  onShare?: (item: FileItem) => void
}

function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    fetch(url, {
      headers: { Range: `bytes=0-${TEXT_PREVIEW_LIMIT - 1}` },
      signal: controller.signal,
    })
      .then(async response => {
        if (!response.ok) throw new Error(`Preview failed (${response.status})`)
        const value = await readTextPreview(response)
        if (!cancelled) setText(value)
      })
      .catch(cause => {
        if (!cancelled && !(cause instanceof DOMException && cause.name === 'AbortError')) {
          setError(errorMessage(cause, 'Preview failed'))
        }
      })
    return () => { cancelled = true; controller.abort() }
  }, [url])

  if (error) return <p className="p-6 text-sm text-vault-danger" role="alert">{error}</p>
  if (text === null) {
    return (
      <div className="grid w-full gap-2 p-6" aria-label="Loading preview">
        {Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-3" />)}
      </div>
    )
  }
  return (
    // Safari will not keyboard-scroll a container unless it is focusable.
    <pre
      tabIndex={0}
      role="region"
      aria-label="File contents"
      className="max-h-full w-full overflow-auto whitespace-pre-wrap wrap-break-word p-6 font-vault-mono text-sm leading-relaxed text-vault-ink"
    >
      {text}
    </pre>
  )
}

function PreviewBody({ item, driveId }: { item: FileItem; driveId?: string }) {
  const [failed, setFailed] = useState(false)
  const kind = previewKind(item.mimeType, item.name)
  const rawUrl = fileUrl.raw(item.id, driveId)

  if (failed) {
    return (
      <div className="grid place-items-center gap-3 p-10 text-center">
        <p className="text-sm text-vault-muted" role="alert">Preview unavailable for this file.</p>
        <Button variant="secondary" asChild>
          <a href={fileUrl.download(item.id, driveId)}><Download /> Download instead</a>
        </Button>
      </div>
    )
  }

  switch (kind) {
    case 'image': return <img className="max-h-full max-w-full object-contain" src={rawUrl} alt={item.name} onError={() => setFailed(true)} />
    // No autoplay: it talks over screen readers.
    case 'video': return <video className="max-h-full max-w-full" src={rawUrl} controls onError={() => setFailed(true)} />
    case 'audio': return <audio className="w-full max-w-xl" src={rawUrl} controls onError={() => setFailed(true)} />
    case 'pdf': return <iframe className="size-full border-0" src={rawUrl} title={`Preview of ${item.name}`} onError={() => setFailed(true)} />
    case 'text': return <TextPreview url={rawUrl} />
    default:
      return (
        <div className="grid place-items-center gap-3 p-10 text-center">
          <span className="grid size-12 place-items-center rounded-vault-md border border-vault-rule bg-vault-paper-2 text-vault-accent">
            <FileQuestion className="size-5" />
          </span>
          <p className="text-sm text-vault-muted">No inline preview for this file type.</p>
          <Button variant="secondary" asChild>
            <a href={fileUrl.download(item.id, driveId)}><Download /> Download instead</a>
          </Button>
        </div>
      )
  }
}

export function PreviewModal({ item, driveId, onClose, onShare }: PreviewModalProps) {
  return (
    <D.Root open onOpenChange={next => { if (!next) onClose() }}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-vault-scrim backdrop-blur-[2px] data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
        <D.Content className="fixed left-1/2 top-1/2 z-50 flex h-[min(90dvh,56rem)] w-[min(72rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-vault-md border border-vault-rule bg-vault-surface shadow-[0_0.5rem_0.5rem_var(--color-shadow)] outline-none data-[state=open]:animate-panel-in data-[state=closed]:animate-panel-out">
          <header className="flex shrink-0 items-center gap-3 border-b border-vault-rule px-4 py-3">
            <span className="min-w-0 flex-1">
              <D.Title className="block truncate text-sm font-semibold">{item.name}</D.Title>
              <D.Description className="block font-vault-mono text-xs text-vault-subtle">
                {formatBytes(item.size)} · {formatDate(item.modifiedTime)}
              </D.Description>
            </span>

            {onShare && (
              <Button variant="ghost" size="icon-sm" onClick={() => onShare(item)} aria-label={`Share ${item.name}`}>
                <Share2 />
              </Button>
            )}
            <Button variant="secondary" size="sm" asChild className="max-[30rem]:hidden">
              <a href={fileUrl.download(item.id, driveId)}><Download /> Download</a>
            </Button>
            <Button variant="ghost" size="icon-sm" asChild className="hidden max-[30rem]:inline-flex">
              <a href={fileUrl.download(item.id, driveId)} aria-label={`Download ${item.name}`}><Download /></a>
            </Button>
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close preview"><X /></Button>
            </D.Close>
          </header>

          <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-vault-paper">
            <PreviewBody item={item} driveId={driveId} />
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
