const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

function bytes(value: string | BufferSource): BufferSource {
  return typeof value === 'string' ? encoder.encode(value) : value
}

export function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256(value: string | BufferSource): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', bytes(value))
}

export async function sha256Hex(value: string | BufferSource): Promise<string> {
  return toHex(await sha256(value))
}

export async function hmacSha256(key: string | BufferSource, data: string | BufferSource): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', bytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', cryptoKey, bytes(data))
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await sha256(secret)
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptSecret(secret: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await encryptionKey(secret)
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext))
  )
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(ciphertext)}`
}

export async function decryptSecret(secret: string, payload: string): Promise<string> {
  const [version, ivText, ciphertextText] = payload.split('.')
  if (version !== 'v1' || !ivText || !ciphertextText) throw new Error('Invalid encrypted secret')
  const key = await encryptionKey(secret)
  const iv = copyBuffer(base64UrlToBytes(ivText))
  const ciphertext = copyBuffer(base64UrlToBytes(ciphertextText))
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  )
  return decoder.decode(plaintext)
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
