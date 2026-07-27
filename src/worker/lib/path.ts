export function normalizeVirtualPath(input: string | null | undefined): string {
  const raw = input ?? '/'
  if (raw.includes('\0') || raw.length > 2048) throw new Error('Invalid path')
  const parts: string[] = []
  for (const part of raw.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return `/${parts.join('/')}`
}

export function pathParts(path: string): string[] {
  return normalizeVirtualPath(path).split('/').filter(Boolean)
}

export function joinVirtualPath(parent: string, name: string): string {
  return normalizeVirtualPath(`${parent}/${name}`)
}

/** Names are single path segments: no separators, no traversal, no control bytes. */
export function isValidName(value: string): boolean {
  return value.length > 0 && value.length <= 255
    && !/[/\\\0]/.test(value)
    && value !== '.' && value !== '..'
}

/** A folder name may legitimately contain % or _, which LIKE would read as wildcards. */
export function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

export function escapeDriveQuery(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
}
