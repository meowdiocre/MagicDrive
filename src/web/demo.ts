import type { FileItem, Session } from '@/types'

// ?preview=1 on localhost renders fixture data with no Worker behind it.
export const demoMode = ['localhost', '127.0.0.1'].includes(window.location.hostname)
  && new URLSearchParams(window.location.search).get('preview') === '1'

export const demoSession: Session = {
  userId: 'preview-user',
  driveId: 'preview-drive',
  username: 'preview-wizard',
  role: 'magician',
}

export const demoItems: FileItem[] = [
  { id: 'folder-documents', name: 'Documents', mimeType: 'application/vnd.google-apps.folder', size: null, modifiedTime: '2026-07-24T08:00:00Z', isFolder: true },
  { id: 'folder-media', name: 'Media', mimeType: 'application/vnd.google-apps.folder', size: null, modifiedTime: '2026-07-22T11:30:00Z', isFolder: true },
  { id: 'folder-projects', name: 'Projects', mimeType: 'application/vnd.google-apps.folder', size: null, modifiedTime: '2026-07-19T15:10:00Z', isFolder: true },
  { id: 'file-brief', name: 'MagicDrive brief.pdf', mimeType: 'application/pdf', size: 1843200, modifiedTime: '2026-07-18T09:20:00Z', isFolder: false },
  { id: 'file-readme', name: 'README.md', mimeType: 'text/markdown', size: 8421, modifiedTime: '2026-07-16T13:45:00Z', isFolder: false },
]
