import { useCallback, useEffect, useRef, useState } from 'react'
import { apiDelete, apiGet, apiPost, errorMessage } from '@/api/client'
import { demoMode } from '@/demo'

export interface ShareItem {
  id: string
  file_id: string
  name: string
  expires_at: string | null
  created_at: string
  /** 1 when the signed-in user created it, 0 when it targets storage they own. */
  mine: number
  drive_name: string
}

export interface CreatedShare {
  id: string
  token: string
  url: string
  name: string
  expiresAt: string | null
}

/** Share links are per-user, so changing accounts invalidates in-flight results. */
export function useShares(userId?: string) {
  const [items, setItems] = useState<ShareItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requestId = useRef(0)

  const refresh = useCallback(async () => {
    const ticket = ++requestId.current
    if (demoMode || !userId) {
      setItems([])
      setError('')
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const data = await apiGet<{ items: ShareItem[] }>('/api/shares', 'Unable to load shares')
      if (ticket !== requestId.current) return
      setItems(data.items)
    } catch (cause) {
      if (ticket !== requestId.current) return
      setError(errorMessage(cause, 'Unable to load shares'))
    } finally {
      if (ticket === requestId.current) setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    void refresh()
    return () => { requestId.current += 1 }
  }, [refresh])

  async function createShare(fileId: string, name: string, expiresInHours?: number, driveId?: string): Promise<CreatedShare> {
    const created = await apiPost<CreatedShare>('/api/shares', { fileId, name, expiresInHours, driveId }, 'Unable to create share')
    void refresh()
    return created
  }

  async function deleteShare(id: string) {
    requestId.current += 1
    await apiDelete(`/api/shares/${encodeURIComponent(id)}`, 'Unable to revoke share link')
    setItems(current => current.filter(item => item.id !== id))
  }

  return { items, loading, error, refresh, createShare, deleteShare }
}

export type SharesState = ReturnType<typeof useShares>
