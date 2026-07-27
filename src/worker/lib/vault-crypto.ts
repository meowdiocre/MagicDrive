import { decryptSecret, encryptSecret, sha256Hex } from './crypto'

const encoder = new TextEncoder()

/**
 * Per-object random key, wrapped by the deployment secret before it touches D1.
 * Segments are AES-GCM with the object id and segment index as AAD, so a
 * segment cannot be swapped into another file or another position undetected.
 */
export async function generateWrappedKey(secret: string): Promise<string> {
  const raw = new Uint8Array(32)
  crypto.getRandomValues(raw)
  return encryptSecret(secret, bytesToBase64Url(raw))
}

export async function unwrapKey(secret: string, wrapped: string): Promise<CryptoKey> {
  const raw = base64UrlToBytes(await decryptSecret(secret, wrapped))
  return crypto.subtle.importKey('raw', copy(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

function aad(objectId: string, index: number): Uint8Array {
  return encoder.encode(`${objectId}:${index}`)
}

/** Returns iv-prefixed ciphertext and its hash, which is checkable without the key. */
export async function encryptSegment(
  key: CryptoKey,
  objectId: string,
  index: number,
  plaintext: ArrayBuffer
): Promise<{ cipher: Uint8Array; sha256: string }> {
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(objectId, index) } as AesGcmParams,
    key,
    plaintext
  ))
  const cipher = new Uint8Array(iv.byteLength + encrypted.byteLength)
  cipher.set(iv, 0)
  cipher.set(encrypted, iv.byteLength)
  return { cipher, sha256: await sha256Hex(cipher) }
}

export async function decryptSegment(
  key: CryptoKey,
  objectId: string,
  index: number,
  cipher: ArrayBuffer
): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(cipher)
  if (bytes.byteLength < 13) throw new Error('Segment too short')
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: copy(bytes.slice(0, 12)), additionalData: aad(objectId, index) } as AesGcmParams,
    key,
    copy(bytes.slice(12))
  )
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0))
}

function copy(bytes: Uint8Array): ArrayBuffer {
  const duplicate = new Uint8Array(bytes.byteLength)
  duplicate.set(bytes)
  return duplicate.buffer
}
