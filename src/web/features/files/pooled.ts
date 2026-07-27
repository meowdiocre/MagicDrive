import type { FileItem } from '@/types'

/** Mirrors POOL_FOLDER_MIME in src/worker/drivers/aggregate.ts. */
export const POOL_FOLDER_MIME = 'application/vnd.magicdrive.pooled-folder'

/** A folder that exists on every connection at once, so it cannot be renamed on one. */
export function isPooledFolder(item: Pick<FileItem, 'mimeType'>): boolean {
  return item.mimeType === POOL_FOLDER_MIME
}
