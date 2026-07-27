import { joinVirtualPath, pathParts } from '../lib/path'
import type { StorageDriver } from './contract'
import type { FileItem } from '../types'

const MAX_LOOKUP_PAGES = 10

export async function findFolder(driver: StorageDriver, path: string, name: string): Promise<FileItem | null> {
  return findFolderBy(driver, path, item => item.name === name)
}

/** Case-insensitive lookup for namespaces where casing does not distinguish names. */
export async function findFolderNamed(driver: StorageDriver, path: string, name: string): Promise<FileItem | null> {
  const wanted = name.toLowerCase()
  return findFolderBy(driver, path, item => item.name.toLowerCase() === wanted)
}

async function findFolderBy(
  driver: StorageDriver,
  path: string,
  matches: (item: FileItem) => boolean
): Promise<FileItem | null> {
  let pageToken: string | null = null
  for (let page = 0; page < MAX_LOOKUP_PAGES; page += 1) {
    const result = await driver.list(path, pageToken)
    const match = result.items.find(item => item.isFolder && matches(item))
    if (match) return match
    pageToken = result.nextPageToken
    if (!pageToken) break
  }
  return null
}

/** Retry lookup once; never treat an unreadable folder as absent. */
export async function ensureFolder(driver: StorageDriver, path: string, name: string): Promise<void> {
  let existing: FileItem | null
  try {
    existing = await findFolder(driver, path, name)
  } catch {
    existing = await findFolder(driver, path, name)
  }
  if (!existing) await driver.mkdir(path, name)
}

export async function ensurePath(driver: StorageDriver, path: string): Promise<void> {
  let current = '/'
  for (const part of pathParts(path)) {
    await ensureFolder(driver, current, part)
    current = joinVirtualPath(current, part)
  }
}

/** Walk every page so later names cannot be shadowed by a duplicate. */
export async function surveyFolder(
  driver: StorageDriver,
  path: string,
  lowercaseName: string
): Promise<{ count: number; taken: boolean; complete: boolean }> {
  let pageToken: string | null = null
  let count = 0
  for (let page = 0; page < MAX_LOOKUP_PAGES; page += 1) {
    const result = await driver.list(path, pageToken)
    count += result.items.length
    if (result.items.some(item => item.name.toLowerCase() === lowercaseName)) {
      return { count, taken: true, complete: true }
    }
    pageToken = result.nextPageToken
    if (!pageToken) return { count, taken: false, complete: true }
  }
  // A bounded walk cannot prove that the name is free.
  return { count, taken: false, complete: false }
}
