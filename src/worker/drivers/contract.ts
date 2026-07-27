import type { FileItem, ListResult } from '../types'

export type Capability = 'list' | 'search' | 'download' | 'upload' | 'mkdir' | 'delete' | 'rename' | 'thumbnail'

/** Nulls mean the provider cannot answer, not zero. */
export interface StorageUsage {
  usedBytes: number | null
  totalBytes: number | null
  freeBytes: number | null
}

export interface StorageDriver {
  readonly capabilities: readonly Capability[]
  list(path: string, pageToken?: string | null): Promise<ListResult>
  search(query: string): Promise<FileItem[]>
  download(fileId: string, request: Request, disposition?: 'attachment' | 'inline'): Promise<Response>
  thumbnail(fileId: string): Promise<Response>
  upload(path: string, filename: string, body: ReadableStream | ArrayBuffer, contentType: string, size: number): Promise<FileItem>
  mkdir(path: string, name: string): Promise<FileItem>
  remove(fileId: string): Promise<void>
  rename(fileId: string, newName: string, path?: string): Promise<Pick<FileItem, 'id' | 'name'>>
  /** Quota, where the provider exposes one. */
  getUsage?(): Promise<StorageUsage>
}
