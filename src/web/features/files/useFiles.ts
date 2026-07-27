import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, errorMessage, query } from '@/api/client'
import { demoItems, demoMode } from '@/demo'
import { MAX_DIRECT_UPLOAD_BYTES, uploadWithProgress } from './upload'
import { uploadToVault } from './vaultUpload'
import type { UploadTask } from './upload'
import type { Capability, FileItem, ListResult } from '@/types'

export const SEARCH_PATH = 'Search results'

/** Per-storage outcome when creating a pooled folder. */
export type PoolTarget = { storage: string; ok: boolean; error?: string }
export type CreatedFolder = FileItem & { storages?: PoolTarget[] }

export function useFiles(driveId: string) {
  const [path, setPathState] = useState('/')
  const [items, setItems] = useState<FileItem[]>([])
  const [capabilities, setCapabilities] = useState<Capability[]>([])
  const [nextPageToken, setNextPageToken] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [error, setError] = useState('')
  const [lockRequired, setLockRequired] = useState(false)
  const [uploads, setUploads] = useState<UploadTask[]>([])

  const drive = driveId || undefined
  // Stops a slow response for an earlier drive or folder overwriting a newer one.
  const requestId = useRef(0)
  // Read at completion time rather than closed over: a batch that outlives a
  // drive switch must not repaint the new drive with the old one's contents.
  const currentDrive = useRef(drive)
  currentDrive.current = drive

  const beginRequest = useCallback((kind: 'files' | 'more' | 'search') => {
    const ticket = ++requestId.current
    setLoading(kind === 'files')
    setLoadingMore(kind === 'more')
    setSearching(kind === 'search')
    return ticket
  }, [])

  const finishRequest = useCallback((ticket: number) => {
    if (ticket !== requestId.current) return
    setLoading(false)
    setLoadingMore(false)
    setSearching(false)
  }, [])

  const cancelRequests = useCallback(() => {
    requestId.current += 1
    setLoading(false)
    setLoadingMore(false)
    setSearching(false)
  }, [])

  const setPath = useCallback((nextPath: string) => {
    cancelRequests()
    setPathState(nextPath)
  }, [cancelRequests])

  // Contents and permissions both belong to the previous drive, so drop them.
  useEffect(() => {
    cancelRequests()
    setCapabilities([])
    setPathState('/')
    setItems([])
    setNextPageToken(null)
    setTruncated(false)
    setSearchQuery('')
    setError('')
    setLockRequired(false)
  }, [cancelRequests, driveId])

  const loadFiles = useCallback(async (nextPath: string) => {
    const ticket = beginRequest('files')
    if (demoMode) {
      setItems(demoItems)
      setCapabilities(['list', 'search', 'download', 'upload', 'mkdir', 'delete', 'rename'])
      setNextPageToken(null)
      setTruncated(false)
      finishRequest(ticket)
      return
    }

    setError('')
    try {
      const data = await apiGet<ListResult>(`/api/files${query({ path: nextPath, drive })}`, 'Unable to load files')
      if (ticket !== requestId.current) return
      setItems(data.items)
      setCapabilities(data.capabilities ?? [])
      setNextPageToken(data.nextPageToken ?? null)
      setTruncated(Boolean(data.truncated))
      setLockRequired(false)
    } catch (cause) {
      if (ticket !== requestId.current) return
      setError(errorMessage(cause, 'Unable to load files'))
      setLockRequired(cause instanceof ApiError && cause.status === 423)
      setItems([])
      setNextPageToken(null)
      setTruncated(false)
    } finally {
      finishRequest(ticket)
    }
  }, [beginRequest, drive, finishRequest])

  async function loadMore() {
    if (!nextPageToken || path === SEARCH_PATH) return
    const ticket = beginRequest('more')
    setError('')
    try {
      const data = await apiGet<ListResult>(
        `/api/files${query({ path, pageToken: nextPageToken, drive })}`,
        'Unable to load more files',
      )
      if (ticket !== requestId.current) return
      setItems(current => [...current, ...data.items])
      setNextPageToken(data.nextPageToken ?? null)
      setLockRequired(false)
    } catch (cause) {
      if (ticket === requestId.current) {
        setError(errorMessage(cause, 'Unable to load more files'))
        setLockRequired(cause instanceof ApiError && cause.status === 423)
      }
    } finally {
      finishRequest(ticket)
    }
  }

  async function search(searchQuery: string): Promise<boolean> {
    const trimmed = searchQuery.trim()
    if (trimmed.length < 2) return false

    const ticket = beginRequest('search')
    setSearchQuery(trimmed)
    setPathState(SEARCH_PATH)
    setItems([])
    setNextPageToken(null)
    setTruncated(false)
    if (demoMode) {
      setItems(demoItems.filter(item => item.name.toLowerCase().includes(trimmed.toLowerCase())))
      finishRequest(ticket)
      return true
    }

    setError('')
    try {
      const data = await apiGet<{ items: FileItem[] }>(`/api/search${query({ q: trimmed, drive })}`, 'Search failed')
      if (ticket !== requestId.current) return false
      setItems(data.items)
      setLockRequired(false)
      return true
    } catch (cause) {
      if (ticket === requestId.current) {
        setError(errorMessage(cause, 'Search failed'))
        setLockRequired(cause instanceof ApiError && cause.status === 423)
      }
      return false
    } finally {
      finishRequest(ticket)
    }
  }

  const clearSearch = useCallback(() => {
    setSearchQuery('')
    setPath('/')
  }, [setPath])

  async function uploadFiles(fileList: File[]): Promise<{ uploaded: number; failed: number }> {
    const target = path === SEARCH_PATH ? '/' : path
    const driveAtStart = drive
    const tasks: UploadTask[] = fileList.map((file, index) => ({
      id: `${Date.now()}-${index}-${file.name}`,
      name: file.name,
      loaded: 0,
      total: file.size,
      status: 'pending',
    }))
    setUploads(tasks)

    let uploaded = 0
    let failed = 0
    for (const [index, file] of fileList.entries()) {
      const id = tasks[index].id
      const update = (patch: Partial<UploadTask>) =>
        setUploads(current => current.map(task => (task.id === id ? { ...task, ...patch } : task)))

      update({ status: 'uploading' })
      try {
        if (drive === 'vault') {
          await uploadToVault(
            file,
            target,
            (loaded, total) => update({ loaded, total }),
            status => update({ status }),
          )
        } else {
          if (file.size > MAX_DIRECT_UPLOAD_BYTES) {
            throw new Error('Files over 95 MB require MagicVault')
          }
          await uploadWithProgress(
            `/api/files/upload${query({ path: target, name: file.name, drive })}`,
            file,
            (loaded, total) => update({ loaded, total }),
            'POST',
            () => update({ status: 'processing', loaded: file.size, total: file.size }),
          )
        }
        update({ status: 'done', loaded: file.size })
        uploaded += 1
      } catch (cause) {
        // One bad file must not abandon the rest of the batch.
        update({ status: 'error', error: errorMessage(cause, 'Upload failed') })
        failed += 1
      }
    }

    // Switching storage mid-upload changes which listing is on screen, so the
    // reload would replace it with the previous drive's contents.
    if (uploaded > 0 && currentDrive.current === driveAtStart) {
      setPathState(target)
      await loadFiles(target)
    }
    return { uploaded, failed }
  }

  const dismissUploads = useCallback(() => setUploads([]), [])

  /** In the pooled storage the folder is created on every connection, so the result reports each one. */
  async function createFolder(name: string): Promise<CreatedFolder> {
    const target = path === SEARCH_PATH ? '/' : path
    const created = await apiPost<CreatedFolder>(
      `/api/files/mkdir${query({ drive })}`,
      { path: target, name },
      'Could not create folder',
    )
    setPathState(target)
    await loadFiles(target)
    return created
  }

  async function renameItem(item: FileItem, newName: string): Promise<void> {
    // WebDAV and S3 ids encode the path, so a rename mints a new id.
    const updated = await apiPatch<Pick<FileItem, 'id' | 'name'>>(
      `/api/files/${encodeURIComponent(item.id)}${query({ drive })}`,
      { name: newName, path: path === SEARCH_PATH ? undefined : path },
      'Rename failed',
    )
    setItems(current => current.map(entry => (entry.id === item.id ? { ...entry, ...updated } : entry)))
  }

  async function deleteItem(item: FileItem): Promise<void> {
    await apiDelete(`/api/files/${encodeURIComponent(item.id)}${query({ drive })}`, 'Delete failed')
    setItems(current => current.filter(entry => entry.id !== item.id))
  }

  function openFolder(item: FileItem) {
    // Search hits carry no path, so their folders cannot be resolved by name.
    if (path === SEARCH_PATH) return
    setPath(path === '/' ? `/${item.name}` : `${path}/${item.name}`)
  }

  const can = (capability: Capability) => capabilities.includes(capability)
  const isSearchView = path === SEARCH_PATH

  return {
    path, setPath, items, nextPageToken, truncated, capabilities, can, isSearchView,
    loading, loadingMore, searching, searchQuery, error, lockRequired,
    loadFiles, loadMore, search, clearSearch, openFolder,
    uploads, uploadFiles, dismissUploads,
    createFolder, renameItem, deleteItem,
  }
}

export type FilesState = ReturnType<typeof useFiles>
