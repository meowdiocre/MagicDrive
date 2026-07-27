import { useState } from 'react'
import { ChevronRight, Download, Eye, MoreHorizontal, Pencil, Share2, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { fileKind, formatBytes, formatDate } from '@/lib/format'
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui'
import { fileIcon } from './fileIcon'
import { fileUrl } from './fileUrl'
import { previewKind, hasThumbnail } from './previewKind'
import type { FileItem, Layout } from '@/types'

// Content-Disposition: attachment means this never navigates the page away.
function triggerDownload(url: string) {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

function Thumb({ item, driveId }: { item: FileItem; driveId?: string }) {
  const [failed, setFailed] = useState(false)
  const Icon = fileIcon(item)

  if (failed || item.isFolder || !hasThumbnail(item.mimeType)) {
    return <Icon className="size-4.5" />
  }
  return (
    <img
      className="size-9 rounded-vault-xs object-cover"
      src={fileUrl.thumbnail(item.id, driveId)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

interface FileRowProps {
  item: FileItem
  layout: Layout
  driveId?: string
  navigable?: boolean
  onOpen: () => void
  onShare?: () => void
  onRename?: () => void
  onDelete?: () => void
}

export function FileRow({ item, layout, driveId, navigable = true, onOpen, onShare, onRename, onDelete }: FileRowProps) {
  const isGrid = layout === 'grid'
  const canPreview = !item.isFolder && previewKind(item.mimeType, item.name) !== 'none'
  const TrailingIcon = item.isFolder ? ChevronRight : canPreview ? Eye : Download

  return (
    <li
      className={cn(
        'group relative grid min-w-0 items-center gap-4 border-b border-vault-rule px-4 text-vault-ink transition-colors duration-(--dur-fast) last:border-b-0 hover:bg-vault-paper-2 focus-within:bg-vault-paper-2',
        isGrid
          ? 'min-h-24 grid-cols-[2.25rem_minmax(0,1fr)_auto] content-start gap-x-3 gap-y-1 border-b-0 bg-vault-surface p-4'
          : 'min-h-14 grid-cols-[2.25rem_minmax(0,1fr)_5.5rem_5rem_7rem_auto] max-[56rem]:grid-cols-[2.25rem_minmax(0,1fr)_auto]',
      )}
    >
      <span className={cn(
        'grid size-9 shrink-0 place-items-center rounded-vault-sm bg-vault-paper-3 text-vault-muted',
        item.isFolder && 'bg-vault-accent-soft text-vault-accent',
      )}>
        <Thumb item={item} driveId={driveId} />
      </span>

      {/* The ::after overlay stretches this button across the row, making the
          filename the row's accessible name. */}
      {item.isFolder && !navigable ? (
        <span className="min-w-0 truncate text-left text-sm font-medium">{item.name}</span>
      ) : (
        <button
          className="min-w-0 truncate text-left text-sm font-medium outline-offset-2 after:absolute after:inset-0 after:content-['']"
          onClick={onOpen}
          aria-label={item.isFolder ? `Open folder ${item.name}` : canPreview ? `Preview ${item.name}` : `Download ${item.name}`}
        >
          {item.name}
        </button>
      )}

      {isGrid ? (
        <span className="col-start-2 truncate font-vault-mono text-xs text-vault-subtle">
          {item.isFolder ? 'Folder' : `${fileKind(item.mimeType, item.name)} · ${formatBytes(item.size)}`}
        </span>
      ) : (
        <>
          <span className="truncate font-vault-mono text-xs text-vault-subtle max-[56rem]:hidden">
            {item.isFolder ? 'Folder' : fileKind(item.mimeType, item.name)}
          </span>
          <span className="font-vault-mono text-xs tabular-nums text-vault-subtle max-[56rem]:hidden">
            {item.isFolder ? '-' : formatBytes(item.size)}
          </span>
          <span className="font-vault-mono text-xs text-vault-subtle max-[56rem]:hidden">
            {formatDate(item.modifiedTime)}
          </span>
        </>
      )}

      {/* z-10 lifts the controls above the stretched-link overlay. */}
      <span className={cn('relative z-10 flex items-center justify-end gap-1', isGrid && 'col-start-3 row-start-1')}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${item.name}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {!item.isFolder && (
              <>
                {canPreview && (
                  <DropdownMenuItem onSelect={onOpen}>
                    <Eye /> Preview
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => triggerDownload(fileUrl.download(item.id, driveId))}>
                  <Download /> Download
                </DropdownMenuItem>
                {onShare && (
                  <DropdownMenuItem onSelect={onShare}>
                    <Share2 /> Share link
                  </DropdownMenuItem>
                )}
              </>
            )}
            {(onRename || onDelete) && !item.isFolder && <DropdownMenuSeparator />}
            {onRename && (
              <DropdownMenuItem onSelect={onRename}>
                <Pencil /> Rename
              </DropdownMenuItem>
            )}
            {onDelete && (
              <DropdownMenuItem destructive onSelect={onDelete}>
                <Trash2 /> Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {(!item.isFolder || navigable) && (
          <span className="grid size-9 place-items-center text-vault-subtle group-hover:text-vault-accent max-[56rem]:hidden" aria-hidden="true">
            <TrailingIcon className="size-4" />
          </span>
        )}
      </span>
    </li>
  )
}
