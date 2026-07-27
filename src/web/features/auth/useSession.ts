import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet } from '@/api/client'
import { demoMode, demoSession } from '@/demo'
import { notify } from '@/lib/toast'
import type { Session } from '@/types'

export function useSession() {
  const [session, setSession] = useState<Session | null>(null)
  const [booting, setBooting] = useState(true)
  const requestId = useRef(0)

  const refresh = useCallback(async () => {
    const ticket = ++requestId.current
    if (demoMode) {
      setSession(demoSession)
      return
    }
    try {
      const data = await apiGet<{ user: Session | null }>('/api/auth/me', 'Unable to read session')
      if (ticket === requestId.current) setSession(data.user)
    } catch {
      if (ticket === requestId.current) setSession(null)
    }
  }, [])

  useEffect(() => {
    void refresh().finally(() => setBooting(false))
  }, [refresh])

  const logout = useCallback(async () => {
    const ticket = ++requestId.current
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' })
      if (!response.ok) throw new Error('Unable to sign out')
      if (ticket === requestId.current) setSession(null)
    } catch (cause) {
      if (ticket === requestId.current) notify.error(cause, 'Unable to sign out')
    }
  }, [])

  return { session, booting, logout, refresh }
}
