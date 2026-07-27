import { useCallback, useEffect, useRef, useState } from 'react'
import { apiDelete, apiGet, apiPatch, apiPost, errorMessage } from '@/api/client'
import { demoMode } from '@/demo'
import { driveHref, driveIdFromSearch, resolveDriveId } from './driveRoute'
import type { DriveInfo, StorageAccessMode } from '@/types'

/** Ownership is answered per session, so signing in or out has to refetch. */
export function useDrives(userId?: string) {
  const [items, setItems] = useState<DriveInfo[]>([])
  const [activeDriveId, setActiveDriveId] = useState('')
  const [error, setError] = useState('')
  const requestId = useRef(0)
  const fallbackDriveId = useRef('')

  const refresh = useCallback(async () => {
    const ticket = ++requestId.current
    if (demoMode) return
    setError('')
    try {
      const data = await apiGet<{ items: DriveInfo[]; activeDriveId: string }>('/api/drives', 'Unable to load storage')
      if (ticket !== requestId.current) return
      fallbackDriveId.current = data.activeDriveId
      setItems(data.items)
      const requested = driveIdFromSearch(window.location.search)
      const selected = resolveDriveId(data.items, requested, data.activeDriveId)
      if (requested && selected !== requested) {
        window.history.replaceState(null, '', driveHref(window.location.href))
      }
      setActiveDriveId(selected)
    } catch (cause) {
      if (ticket !== requestId.current) return
      setError(errorMessage(cause, 'Unable to load storage'))
    }
  }, [])

  useEffect(() => {
    requestId.current += 1
    setItems([])
    setActiveDriveId('')
    void refresh()
    return () => { requestId.current += 1 }
  }, [refresh, userId])

  useEffect(() => {
    const syncFromUrl = () => {
      setActiveDriveId(resolveDriveId(items, driveIdFromSearch(window.location.search), fallbackDriveId.current))
    }
    window.addEventListener('popstate', syncFromUrl)
    return () => window.removeEventListener('popstate', syncFromUrl)
  }, [items])

  const selectDrive = useCallback((id: string) => {
    const selected = items.find(item => item.id === id)
    if (!selected) return
    setActiveDriveId(id)
    window.history.pushState(null, '', driveHref(window.location.href, selected))
  }, [items])

  async function addDrive(
    provider: string,
    name: string,
    config: Record<string, string>,
    accessMode: StorageAccessMode,
    password: string,
    poolContributor: boolean,
  ) {
    await apiPost(
      '/api/drives',
      { provider, name, config, accessMode, password, poolContributor },
      'Unable to connect storage',
    )
    await refresh()
  }

  function startOAuth(
    provider: string,
    accessMode: StorageAccessMode,
    password: string,
    poolContributor: boolean,
  ) {
    return apiPost<{ url: string }>(
      `/api/auth/${encodeURIComponent(provider)}/start`,
      { accessMode, password, poolContributor, returnTo: '/' },
      'Unable to start provider authorization',
    )
  }

  async function unlockDrive(id: string, password: string) {
    await apiPost(`/api/drives/${encodeURIComponent(id)}/unlock`, { password }, 'Unable to unlock storage')
    await refresh()
  }

  async function renameDrive(id: string, name: string) {
    await apiPatch(`/api/drives/${encodeURIComponent(id)}`, { name }, 'Unable to rename storage')
    await refresh()
  }

  async function deleteDrive(id: string) {
    await apiDelete(`/api/drives/${encodeURIComponent(id)}`, 'Unable to disconnect storage')
    await refresh()
  }

  return {
    items, activeDriveId, error, refresh,
    addDrive, startOAuth, unlockDrive, renameDrive, deleteDrive, setActiveDriveId: selectDrive,
  }
}

export type DrivesState = ReturnType<typeof useDrives>
