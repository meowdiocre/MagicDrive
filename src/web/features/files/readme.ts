import type { FileItem } from '@/types'

export function findReadme(items: FileItem[]): FileItem | undefined {
  return items.find(item => !item.isFolder && item.name.toLowerCase() === 'readme.md')
}
