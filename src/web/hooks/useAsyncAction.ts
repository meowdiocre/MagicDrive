import { useCallback, useRef, useState } from 'react'
import { errorMessage } from '@/api/client'

/** Submit state for a dialog: one in-flight action, its failure kept for display. */
export function useAsyncAction(fallback: string) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const running = useRef(false)

  const run = useCallback(async (action: () => void | Promise<void>): Promise<boolean> => {
    if (running.current) return false
    running.current = true
    setBusy(true)
    setError('')
    try {
      await action()
      return true
    } catch (cause) {
      setError(errorMessage(cause, fallback))
      return false
    } finally {
      running.current = false
      setBusy(false)
    }
  }, [fallback])

  return { busy, error, setError, run }
}
