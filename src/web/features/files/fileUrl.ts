import { query } from '@/api/client'

// Without the drive param the Worker falls back to the session's default drive.
export const fileUrl = {
  download: (id: string, driveId?: string) => `/api/files/${encodeURIComponent(id)}/download${query({ drive: driveId })}`,
  raw: (id: string, driveId?: string) => `/api/files/${encodeURIComponent(id)}/raw${query({ drive: driveId })}`,
  thumbnail: (id: string, driveId?: string) => `/api/files/${encodeURIComponent(id)}/thumbnail${query({ drive: driveId })}`,
}
