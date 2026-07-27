export interface UploadTask {
  id: string
  name: string
  loaded: number
  total: number
  status: 'pending' | 'uploading' | 'processing' | 'done' | 'error'
  error?: string
}

export const MAX_DIRECT_UPLOAD_BYTES = 95 * 1024 * 1024
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000

// XHR rather than fetch: fetch cannot report upload progress.
export function uploadWithProgress(
  url: string,
  body: Blob,
  onProgress: (loaded: number, total: number) => void,
  method: 'POST' | 'PUT' = 'POST',
  onProcessing?: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open(method, url)
    request.timeout = UPLOAD_TIMEOUT_MS
    request.setRequestHeader('Content-Type', body.type || 'application/octet-stream')

    request.upload.addEventListener('progress', event => {
      if (event.lengthComputable) onProgress(event.loaded, event.total)
    })
    request.upload.addEventListener('load', () => {
      onProgress(body.size, body.size)
      onProcessing?.()
    })

    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(body.size, body.size)
        resolve()
        return
      }
      let message = `Upload failed (${request.status})`
      try {
        const payload = JSON.parse(request.responseText)
        if (payload?.error) message = payload.error
      } catch {
        // Non-JSON body, keep the status message.
      }
      reject(new Error(message))
    })

    request.addEventListener('error', () => reject(new Error('Upload failed: network error')))
    request.addEventListener('abort', () => reject(new Error('Upload cancelled')))
    request.addEventListener('timeout', () => reject(new Error('Upload timed out')))
    request.send(body)
  })
}
