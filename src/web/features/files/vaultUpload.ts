import { apiDelete, apiPost } from '@/api/client'
import { uploadWithProgress } from './upload'

interface VaultSession {
  id: string
  segmentSize: number
  segmentCount: number
}

const SEGMENT_ATTEMPTS = 3

/**
 * MagicVault takes files in pieces: open a session, send each slice as its own
 * request, commit. No request carries more than one segment, so the Worker's
 * body cap stops mattering and a lost connection only loses the current piece.
 */
export async function uploadToVault(
  file: File,
  path: string,
  onProgress: (loaded: number, total: number) => void,
  onPhase: (phase: 'uploading' | 'processing') => void,
): Promise<void> {
  const session = await apiPost<VaultSession>('/api/vault/uploads', {
    path,
    name: file.name,
    size: file.size,
    contentType: file.type || 'application/octet-stream',
  }, 'Could not start the upload')

  try {
    for (let index = 0; index < session.segmentCount; index += 1) {
      const from = index * session.segmentSize
      const slice = file.slice(from, Math.min(from + session.segmentSize, file.size))
      let lastError: unknown
      for (let attempt = 1; attempt <= SEGMENT_ATTEMPTS; attempt += 1) {
        try {
          onPhase('uploading')
          await uploadWithProgress(
            `/api/vault/uploads/${encodeURIComponent(session.id)}/segments/${index}`,
            slice,
            loaded => onProgress(Math.min(from + loaded, file.size), file.size),
            'PUT',
            () => onPhase('processing'),
          )
          lastError = undefined
          break
        } catch (cause) {
          lastError = cause
        }
      }
      if (lastError) throw lastError
    }
    onPhase('processing')
    await apiPost(`/api/vault/uploads/${encodeURIComponent(session.id)}/commit`, {}, 'Could not finish the upload')
    onProgress(file.size, file.size)
  } catch (cause) {
    await apiDelete(`/api/vault/uploads/${encodeURIComponent(session.id)}`, 'cancel failed').catch(() => {})
    throw cause
  }
}
