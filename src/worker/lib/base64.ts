const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function encodeBase64UrlUtf8(value: string): string {
  let binary = ''
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function decodeBase64UrlUtf8(value: string): string {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url value')
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  return decoder.decode(Uint8Array.from(binary, char => char.charCodeAt(0)))
}

export function encodeBase64Utf8(value: string): string {
  let binary = ''
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte)
  return btoa(binary)
}
