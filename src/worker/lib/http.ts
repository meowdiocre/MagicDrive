import type { Context } from 'hono'

/**
 * workerd drops a hand-set Content-Length on a streamed request body and sends
 * chunked instead, which breaks SigV4 (the header is signed but never arrives)
 * and any server that requires a length. FixedLengthStream makes the runtime
 * emit a real one. Absent outside workerd, where the body passes through.
 */
export function fixedLength(body: ReadableStream, size: number): ReadableStream {
  const Stream = (globalThis as {
    FixedLengthStream?: new (size: number) => { readable: ReadableStream; writable: WritableStream }
  }).FixedLengthStream
  if (!Stream) return body
  const measured = new Stream(size)
  void body.pipeTo(measured.writable).catch(() => {})
  return measured.readable
}

export function ok<T>(c: Context, data: T, status = 200) {
  return c.json({ data }, status as any)
}

export function fail(c: Context, message: string, status = 400) {
  return c.json({ error: message }, status as any)
}
