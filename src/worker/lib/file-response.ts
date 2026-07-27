const FORWARDED_HEADERS = [
  'Content-Type', 'Content-Length', 'Content-Range',
  'Accept-Ranges', 'ETag', 'Last-Modified',
] as const

export function providerFileResponse(
  upstream: Response,
  filename: string,
  disposition: 'attachment' | 'inline',
): Response {
  const headers = new Headers()
  for (const key of FORWARDED_HEADERS) {
    const value = upstream.headers.get(key)
    if (value) headers.set(key, value)
  }
  const fallback = filename.replace(/["\\\r\n]/g, '_').replace(/[^\x20-\x7E]/g, '_') || 'download'
  headers.set('Content-Disposition', `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
  headers.set('Cache-Control', 'private, no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  return new Response(upstream.body, { status: upstream.status, headers })
}
