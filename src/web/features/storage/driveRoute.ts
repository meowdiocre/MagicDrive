export type RoutableDrive = { id: string; is_virtual: boolean }

export function driveIdFromSearch(search: string): string {
  const value = new URLSearchParams(search).get('drive')?.trim() ?? ''
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : ''
}

export function resolveDriveId(drives: RoutableDrive[], requested: string, fallback: string): string {
  return requested && drives.some(drive => drive.id === requested) ? requested : fallback
}

export function driveHref(href: string, drive?: RoutableDrive): string {
  const url = new URL(href)
  if (!drive || drive.is_virtual) url.searchParams.delete('drive')
  else url.searchParams.set('drive', drive.id)
  return `${url.pathname}${url.search}${url.hash}`
}
