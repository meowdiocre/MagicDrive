import { lazy, Suspense, useEffect, useRef, useState } from 'react'
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
import { CapacityPanel } from './CapacityPanel'
import { findReadme } from './readme'
import { FolderAccessDialog, UnlockFolderDialog } from './FolderAccessDialogs'
import type { FilesState } from './useFiles'
import type { DrivesState } from '@/features/storage/useDrives'
import type { SharesState } from '@/features/shares/useShares'
import type { FileItem, Layout } from '@/types'

const FolderReadme = lazy(() => import('./FolderReadme'))

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
  const [accessTarget, setAccessTarget] = useState<FileItem | null>(null)
  const [unlockFolderTarget, setUnlockFolderTarget] = useState<FileItem | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [capacityRefresh, setCapacityRefresh] = useState(0)
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
  const showCapacity = (pooled && magician) || (vault && can('upload'))
  const readOnly = Boolean(activeDrive && !activeDrive.is_owner && !activeDrive.is_virtual)
  const title = isSearchView ? 'Search results' : path === '/' ? (activeDrive?.name ?? 'Files') : path.split('/').at(-1)
  const readme = !isSearchView && !locked ? findReadme(items) : undefined

  useEffect(() => {
    if (locked) setUnlocking(true)
  }, [activeDrive?.id, locked])

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [activeDriveId, path])

  function openItem(item: FileItem) {
    if (item.isFolder && item.locked) setUnlockFolderTarget(item)
    else if (item.isFolder) files.openFolder(item)
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
      if (uploaded > 0) setCapacityRefresh(value => value + 1)
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
              <Tooltip label="Shared contributed storage">
                <span><Badge tone="accent"><Layers /> pooled</Badge></span>
              </Tooltip>
            )}
            {magician && (
              <Tooltip label="Cauldron administrator">
                <span><Badge tone="accent"><WandSparkles /> magician</Badge></span>
              </Tooltip>
            )}
            {vault && (
              <Tooltip label="Encrypted distributed storage">
                <span><Badge tone="accent"><WandSparkles /> managed</Badge></span>
              </Tooltip>
            )}
            {readOnly && (
              <Tooltip label={`${activeDrive?.owner_name} owns this storage. You can browse and download.`}>
                <span><Badge tone="neutral"><Lock /> read-only</Badge></span>
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

      {error && !locked && items.length > 0 && (
        <ErrorBanner
          message={error}
          onRetry={() => void (isSearchView ? files.search(files.searchQuery) : files.loadFiles(path))}
        />
      )}

      <UploadTray uploads={files.uploads} onDismiss={files.dismissUploads} />

      <div className={cn(
        'grid gap-4',
        showCapacity && 'grid-cols-[minmax(0,1fr)_18rem] max-[72rem]:grid-cols-1',
      )}>
        <div className="grid min-w-0 content-start gap-4">
          <section
            className={cn(
              'overflow-hidden rounded-vault-md border border-vault-rule bg-vault-surface transition-[border-color,box-shadow] duration-(--dur-fast)',
              dragOver && 'border-vault-accent ring-2 ring-vault-accent-soft',
            )}
            onDragOver={event => {
              event.preventDefault()
              if (can('upload') && !uploading) setDragOver(true)
            }}
            onDragLeave={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false)
            }}
            onDrop={event => {
              event.preventDefault()
              setDragOver(false)
              if (!can('upload') || uploading) return
              void handleFiles(event.dataTransfer.files)
            }}
          >
            <div className="flex min-h-10 items-center border-b border-vault-rule px-4 font-vault-mono text-xs text-vault-muted">
              <span aria-live="polite">{locked ? 'Locked' : loading ? 'Loading...' : `${items.length} item${items.length === 1 ? '' : 's'}`}</span>
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
                  description="Try again or choose another storage."
                  action={<Button variant="secondary" size="sm" onClick={() => void (isSearchView ? files.search(files.searchQuery) : files.loadFiles(path))}>Retry</Button>}
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
                    onShare={canShare && !item.system ? () => setShareItem(item) : undefined}
                    onRename={can('rename') && !item.locked && (!isSearchView || !pooled) && !isPooledFolder(item) && !item.readOnly ? () => setRenameTarget(item) : undefined}
                    onDelete={can('delete') && !item.locked && (!isSearchView || !pooled) && !item.readOnly ? () => setDeleteTarget(item) : undefined}
                    onAccess={item.isFolder && ((vault && !item.readOnly) || magician) ? () => setAccessTarget(item) : undefined}
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

          {readme && activeDriveId && (
            <Suspense fallback={null}>
              <FolderReadme item={readme} driveId={activeDriveId} onOpen={() => setPreviewItem(readme)} />
            </Suspense>
          )}
        </div>

        {showCapacity && activeDriveId && (
          <div className="max-[72rem]:order-first">
            <CapacityPanel driveId={activeDriveId} refreshKey={capacityRefresh} />
          </div>
        )}
      </div>

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
          onShare={canShare && !previewItem.system ? item => { setPreviewItem(null); setShareItem(item) } : undefined}
        />
      )}

      {shareItem && canShare && (
        <ShareDialog item={shareItem} shares={shares} driveId={activeDriveId} onClose={() => setShareItem(null)} />
      )}

      <FolderAccessDialog
        item={accessTarget}
        onSave={async (mode, password) => {
          if (!accessTarget) return
          await files.setFolderAccess(accessTarget, mode, password)
          notify.success(`Updated access for “${accessTarget.name}”`)
        }}
        onClose={() => setAccessTarget(null)}
      />

      <UnlockFolderDialog
        item={unlockFolderTarget}
        onUnlock={async password => {
          if (!unlockFolderTarget) return
          await files.unlockFolder(unlockFolderTarget, password)
          const target = unlockFolderTarget
          setUnlockFolderTarget(null)
          files.openFolder(target)
          notify.success(`Unlocked “${target.name}”`)
        }}
        onClose={() => setUnlockFolderTarget(null)}
      />

      <PromptDialog
        open={creatingFolder}
        title="New folder"
        label="Folder name"
        submitLabel="Create"
        onSubmit={async name => {
          await files.createFolder(name)
          notify.success(`Created “${name}”`)
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
            setCapacityRefresh(value => value + 1)
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
