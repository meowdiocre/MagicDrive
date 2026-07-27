import { useEffect, useRef, useState } from 'react'
import { Copy, FolderPlus, FolderSearch, HardDrive, Layers, LoaderCircle, Lock, LockKeyhole, Upload, WandSparkles, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { notify } from '@/lib/toast'
import { Badge, Button, Tooltip } from '@/components/ui'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { PromptDialog } from '@/components/PromptDialog'
import { ShareDialog } from '@/features/shares/ShareDialog'
import { UnlockStorageDialog } from '@/features/storage/UnlockStorageDialog'
import { Breadcrumbs } from './Breadcrumbs'
import { DriveSwitcher } from './DriveSwitcher'
import { FileRow } from './FileRow'
import { gridClass, LoadingRows } from './FileGrid'
import { LayoutToggle } from './LayoutToggle'
import { PreviewModal } from './PreviewModal'
import { isPooledFolder } from './pooled'
import { UploadTray } from './UploadTray'
import type { FilesState } from './useFiles'
import type { DrivesState } from '@/features/storage/useDrives'
import type { SharesState } from '@/features/shares/useShares'
import type { FileItem, Layout } from '@/types'

interface FilesViewProps {
  files: FilesState
  shares: SharesState
  drives: DrivesState
  layout: Layout
  canShare: boolean
  onChangeLayout: (value: Layout) => void
  onConnect: () => void
}

export function FilesView({ files, shares, drives, layout, canShare, onChangeLayout, onConnect }: FilesViewProps) {
  const { path, setPath, items, nextPageToken, truncated, loading, loadingMore, error, can, isSearchView } = files
  const [previewItem, setPreviewItem] = useState<FileItem | null>(null)
  const [shareItem, setShareItem] = useState<FileItem | null>(null)
  const [renameTarget, setRenameTarget] = useState<FileItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<FileItem | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [unlocking, setUnlocking] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const activeDrive = drives.items.find(drive => drive.id === drives.activeDriveId)
  const activeDriveId = drives.activeDriveId || undefined
  const vault = activeDrive?.provider === 'vault'
  const pooled = Boolean(activeDrive?.is_virtual) && !vault
  const locked = Boolean(activeDrive?.access_mode === 'protected' && (activeDrive.locked || files.lockRequired))
  // The Worker grants folder creation in the pool to magicians alone, so the
  // capability it sends back is the honest signal for the role.
  const magician = pooled && can('mkdir')
  const readOnly = Boolean(activeDrive && !activeDrive.is_owner && !activeDrive.is_virtual)
  const title = isSearchView ? 'Search results' : path === '/' ? (activeDrive?.name ?? 'Files') : path.split('/').at(-1)

  useEffect(() => {
    if (locked) setUnlocking(true)
  }, [activeDrive?.id, locked])

  function openItem(item: FileItem) {
    if (item.isFolder) files.openFolder(item)
    else setPreviewItem(item)
  }

  function deleteMessage(item: FileItem): string {
    if (isPooledFolder(item)) {
      return `“${item.name}” exists on every connected storage. It will be removed from all of them, `
        + 'with everything inside it. This cannot be undone.'
    }
    return `“${item.name}” will be ${item.isFolder ? 'deleted with its contents' : 'deleted'}. ${
      activeDrive?.provider === 'google' ? 'Google Drive moves it to trash.' : 'This cannot be undone.'
    }`
  }

  async function handleFiles(fileList: FileList | null) {
    const selected = Array.from(fileList ?? [])
    // A second batch would reset the tray and interleave with the first.
    if (selected.length === 0 || uploading) return
    setUploading(true)
    try {
      const { uploaded, failed } = await files.uploadFiles(selected)
      if (uploaded && !failed) notify.success(uploaded === 1 ? `Uploaded ${selected[0].name}` : `Uploaded ${uploaded} files`)
      else if (uploaded && failed) notify.message(`Uploaded ${uploaded} of ${selected.length}`, `${failed} failed. See the list above.`)
      else notify.error(null, 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function copyDriveLink() {
    try {
      await navigator.clipboard.writeText(window.location.href)
      notify.success('Storage link copied')
    } catch (cause) {
      notify.error(cause, 'Could not copy storage link')
    }
  }

  return (
    <>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <Breadcrumbs path={path} onNavigate={setPath} />
          <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
            <h1 className="m-0 min-w-0 max-w-[24ch] truncate font-vault-display text-2xl font-semibold tracking-[-0.03em]">
              {title}
            </h1>
            {pooled && (
              <Tooltip label="Combined view of all connected storage">
                <span tabIndex={0}><Badge tone="accent"><Layers /> pooled</Badge></span>
              </Tooltip>
            )}
            {magician && (
              <Tooltip label="Folders are added to every connected storage; uploads use the pool">
                <span tabIndex={0}><Badge tone="accent"><WandSparkles /> magician</Badge></span>
              </Tooltip>
            )}
            {vault && (
              <Tooltip label="Files are encrypted and distributed across the owner's connected storage">
                <span tabIndex={0}><Badge tone="accent"><WandSparkles /> managed</Badge></span>
              </Tooltip>
            )}
            {readOnly && (
              <Tooltip label={`${activeDrive?.owner_name} owns this storage. You can browse and download.`}>
                <span tabIndex={0}><Badge tone="neutral"><Lock /> read-only</Badge></span>
              </Tooltip>
            )}
            {activeDrive?.access_mode === 'protected' && (
              <Badge tone="warning"><LockKeyhole /> {locked ? 'locked' : 'protected'}</Badge>
            )}
            {activeDrive && !activeDrive.is_virtual && activeDrive.access_mode !== 'private' && (
              <Tooltip label="Copy link to this storage">
                <Button variant="ghost" size="icon-sm" aria-label="Copy storage link" onClick={() => void copyDriveLink()}>
                  <Copy />
                </Button>
              </Tooltip>
            )}
            {isSearchView && (
              <Button variant="ghost" size="sm" onClick={files.clearSearch}>
                <X /> Clear search
              </Button>
            )}
          </div>
        </div>

        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 max-[42rem]:w-full max-[42rem]:justify-start">
          {drives.items.length > 0 && (
            <DriveSwitcher
              drives={drives.items}
              activeDriveId={drives.activeDriveId}
              onSwitch={driveId => drives.setActiveDriveId(driveId)}
              className="max-[42rem]:w-full max-[42rem]:max-w-none"
            />
          )}
          <LayoutToggle layout={layout} onChange={onChangeLayout} />
          {can('mkdir') && (
            <Button variant="secondary" size="sm" onClick={() => setCreatingFolder(true)}>
              <FolderPlus /> New folder
            </Button>
          )}
          {can('upload') && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="sr-only"
                aria-hidden="true"
                tabIndex={-1}
                onChange={event => void handleFiles(event.target.files)}
              />
              <Button variant="primary" size="sm" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
                {uploading ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <Upload />}
                {uploading ? 'Uploading...' : 'Upload'}
              </Button>
            </>
          )}
        </div>
      </header>

      {error && !locked && (
        <ErrorBanner
          message={error}
          onRetry={() => void (isSearchView ? files.search(files.searchQuery) : files.loadFiles(path))}
        />
      )}

      <UploadTray uploads={files.uploads} onDismiss={files.dismissUploads} />

      <section
        className={cn(
          'overflow-hidden rounded-vault-md border border-vault-rule bg-vault-surface transition-[border-color,box-shadow] duration-(--dur-fast)',
          dragOver && 'border-vault-accent ring-2 ring-vault-accent-soft',
        )}
        onDragOver={event => { if (can('upload') && !uploading) { event.preventDefault(); setDragOver(true) } }}
        onDragLeave={() => setDragOver(false)}
        onDrop={event => {
          if (!can('upload') || uploading) return
          event.preventDefault()
          setDragOver(false)
          void handleFiles(event.dataTransfer.files)
        }}
      >
        <div className="flex min-h-10 items-center justify-between gap-4 border-b border-vault-rule px-4 font-vault-mono text-xs text-vault-muted">
          <span aria-live="polite">{locked ? 'Locked' : loading ? 'Loading...' : `${items.length} item${items.length === 1 ? '' : 's'}`}</span>
          <span className="truncate text-vault-subtle">
            {locked ? 'storage password required'
              : can('upload')
              ? vault ? 'drop files to upload to MagicVault'
                : pooled ? 'drop files to upload to the pool' : 'drop files to upload'
              : vault ? 'encrypted files on their owners’ storage'
                : pooled
                  ? magician ? 'create a folder to start using the pool' : 'combined space from every connected storage'
                  : readOnly ? `shared by ${activeDrive?.owner_name}` : 'read-only'}
          </span>
        </div>

        {locked ? (
          <EmptyState
            icon={LockKeyhole}
            title={`${activeDrive?.name ?? 'Storage'} is locked`}
            description="Enter its password to browse, search, preview, or download files."
            action={<Button variant="primary" size="sm" onClick={() => setUnlocking(true)}>Unlock storage</Button>}
          />
        ) : loading ? (
          <LoadingRows layout={layout} />
        ) : items.length === 0 ? (
          error ? (
            <EmptyState
              icon={FolderSearch}
              title={isSearchView ? 'Search failed' : 'Could not load this folder'}
              description={isSearchView ? 'Retry above, or change the search term.' : 'Retry above, or pick a different storage.'}
            />
          ) : isSearchView ? (
            <EmptyState
              icon={FolderSearch}
              title="No matches"
              description="No files match that search. Try another term or storage."
              action={<Button variant="secondary" size="sm" onClick={files.clearSearch}>Back to files</Button>}
            />
          ) : drives.items.length === 0 ? (
            <EmptyState
              icon={HardDrive}
              title="Nothing here yet"
              description="Connect Google Drive, WebDAV, or S3 to get started."
              illustration
              action={<Button variant="secondary" size="sm" onClick={onConnect}>Go to storage</Button>}
            />
          ) : (
            <EmptyState
              icon={FolderSearch}
              title="This folder is empty"
              description={can('upload')
                ? 'Drop files here to upload them, or create a folder.'
                : 'Check a different folder, or switch storage.'}
              action={<Button variant="secondary" size="sm" onClick={onConnect}>Manage storage</Button>}
            />
          )
        ) : (
          <ul className={gridClass(layout)} aria-label={`${title} contents`}>
            {items.map(item => (
              <FileRow
                key={`${item.id}-${item.name}`}
                item={item}
                layout={layout}
                driveId={activeDriveId}
                navigable={!isSearchView}
                onOpen={() => openItem(item)}
                onShare={canShare ? () => setShareItem(item) : undefined}
                onRename={can('rename') && (!isSearchView || !pooled) && !isPooledFolder(item) && !item.readOnly ? () => setRenameTarget(item) : undefined}
                onDelete={can('delete') && (!isSearchView || !pooled) && !item.readOnly ? () => setDeleteTarget(item) : undefined}
              />
            ))}
          </ul>
        )}

        {nextPageToken && (
          <div className="flex justify-center border-t border-vault-rule p-4">
            <Button variant="secondary" size="sm" onClick={() => void files.loadMore()} disabled={loadingMore}>
              {loadingMore ? 'Loading...' : 'Load more'}
            </Button>
          </div>
        )}

        {truncated && (
          <p className="border-t border-vault-rule px-4 py-3 font-vault-mono text-xs text-vault-subtle">
            Some items are not shown here. Open the source storage to view the full folder.
          </p>
        )}
      </section>

      {activeDrive?.access_mode === 'protected' && (
        <UnlockStorageDialog
          open={unlocking}
          name={activeDrive.name}
          onClose={() => setUnlocking(false)}
          onUnlock={async password => {
            await drives.unlockDrive(activeDrive.id, password)
            if (files.isSearchView) await files.search(files.searchQuery)
            else await files.loadFiles(files.path)
            notify.success(`Unlocked ${activeDrive.name}`)
          }}
        />
      )}

      {previewItem && (
        <PreviewModal
          item={previewItem}
          driveId={activeDriveId}
          onClose={() => setPreviewItem(null)}
          onShare={canShare ? item => { setPreviewItem(null); setShareItem(item) } : undefined}
        />
      )}

      {shareItem && canShare && (
        <ShareDialog item={shareItem} shares={shares} driveId={activeDriveId} onClose={() => setShareItem(null)} />
      )}

      <PromptDialog
        open={creatingFolder}
        title="New folder"
        label="Folder name"
        submitLabel="Create"
        onSubmit={async name => {
          const created = await files.createFolder(name)
          const refused = created.storages?.filter(target => !target.ok) ?? []
          if (refused.length === 0) notify.success(`Created “${name}”`)
          else notify.message(`Created “${name}”`, `Not on ${refused.map(target => target.storage).join(', ')}: ${refused[0].error}`)
        }}
        onClose={() => setCreatingFolder(false)}
      />

      <PromptDialog
        open={Boolean(renameTarget)}
        key={renameTarget?.id ?? 'rename'}
        title="Rename"
        description={renameTarget?.name}
        label="New name"
        initialValue={renameTarget?.name ?? ''}
        submitLabel="Rename"
        selectBasename={!renameTarget?.isFolder}
        onSubmit={async name => {
          if (!renameTarget || name === renameTarget.name) return
          await files.renameItem(renameTarget, name)
          notify.success(`Renamed to “${name}”`)
        }}
        onClose={() => setRenameTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={!deleteTarget?.isFolder ? 'Delete file' : isPooledFolder(deleteTarget) ? 'Delete pooled folder' : 'Delete folder'}
        message={deleteTarget ? deleteMessage(deleteTarget) : ''}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!deleteTarget) return
          try {
            await files.deleteItem(deleteTarget)
            notify.success(`Deleted “${deleteTarget.name}”`)
          } catch (cause) {
            notify.error(cause, 'Delete failed')
          }
        }}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  )
}
