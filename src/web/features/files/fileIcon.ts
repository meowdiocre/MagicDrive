import {
  File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet,
  FileText, FileVideo, Folder, Presentation,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { FileItem } from '@/types'

const byMime: [RegExp, LucideIcon][] = [
  [/^image\//, FileImage],
  [/^video\//, FileVideo],
  [/^audio\//, FileAudio],
  [/pdf/, FileText],
  [/zip|x-7z|x-rar|x-tar|gzip|compressed/, FileArchive],
  [/vnd\.google-apps\.spreadsheet|spreadsheetml|csv/, FileSpreadsheet],
  [/vnd\.google-apps\.presentation|presentationml/, Presentation],
  [/vnd\.google-apps\.document|wordprocessingml|^text\/(plain|markdown)/, FileText],
  [/json|xml|javascript|typescript|x-sh|x-yaml|x-python/, FileCode],
]

const byExtension: [RegExp, LucideIcon][] = [
  [/\.(ts|tsx|js|jsx|py|go|rs|sh|rb|java|c|cpp|cs|php|sql)$/i, FileCode],
  [/\.(json|ya?ml|toml|ini|env|xml)$/i, FileCode],
  [/\.(csv|tsv|xlsx?|numbers)$/i, FileSpreadsheet],
  [/\.(pptx?|key)$/i, Presentation],
  [/\.(zip|7z|rar|tar|gz|bz2)$/i, FileArchive],
  [/\.(md|txt|rtf|docx?|pages)$/i, FileText],
]

export function fileIcon(item: Pick<FileItem, 'mimeType' | 'name' | 'isFolder'>): LucideIcon {
  if (item.isFolder) return Folder
  for (const [pattern, icon] of byMime) {
    if (pattern.test(item.mimeType)) return icon
  }
  for (const [pattern, icon] of byExtension) {
    if (pattern.test(item.name)) return icon
  }
  return File
}
