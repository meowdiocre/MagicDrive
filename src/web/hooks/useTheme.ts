import { useCallback, useEffect, useState } from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ThemeState = {
  preference: ThemePreference
  resolved: 'light' | 'dark'
  setTheme: (value: ThemePreference) => void
}

const STORAGE_KEY = 'vd_theme'
const PREFERENCES: ThemePreference[] = ['light', 'dark', 'system']

function read(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return PREFERENCES.includes(stored as ThemePreference) ? (stored as ThemePreference) : 'system'
  } catch {
    return 'system'
  }
}

export function useTheme(): ThemeState {
  const [preference, setPreference] = useState<ThemePreference>(read)

  useEffect(() => {
    const root = document.documentElement
    if (preference === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', preference)
    try {
      localStorage.setItem(STORAGE_KEY, preference)
    } catch {
      // The selected theme still applies for this tab.
    }
  }, [preference])

  const resolved = useResolvedTheme(preference)
  const setTheme = useCallback((next: ThemePreference) => setPreference(next), [])

  return { preference, resolved, setTheme }
}

function useResolvedTheme(preference: ThemePreference): 'light' | 'dark' {
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  if (preference === 'system') return systemDark ? 'dark' : 'light'
  return preference
}
