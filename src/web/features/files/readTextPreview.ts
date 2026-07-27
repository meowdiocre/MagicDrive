export const TEXT_PREVIEW_LIMIT = 256 * 1024

export async function readTextPreview(response: Response, limit = TEXT_PREVIEW_LIMIT): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let remaining = limit
  let text = ''

  try {
    while (remaining > 0) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = value.subarray(0, remaining)
      text += decoder.decode(chunk, { stream: chunk.byteLength === value.byteLength })
      remaining -= chunk.byteLength
      if (chunk.byteLength < value.byteLength) break
    }
    text += decoder.decode()
    return text
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
