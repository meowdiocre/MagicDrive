import { useCallback, useState } from 'react'

export function useLocalStorage<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key)
      return allowed.includes(stored as T) ? (stored as T) : fallback
    } catch {
      return fallback
    }
  })

  const update = useCallback((next: T) => {
    setValue(next)
    try {
      localStorage.setItem(key, next)
    } catch {
      // The preference still applies for this tab when storage is unavailable.
    }
  }, [key])

  return [value, update]
}
