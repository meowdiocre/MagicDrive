import { hmacSha256, sha256, toHex } from './crypto'

const MIN_LENGTH = 16
const MIN_WORDS = 3
/** Single-word spells need more entropy. */
const MIN_SINGLE_WORD_LENGTH = 24

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{2,23}$/

/** Normalize equivalent spellings without dropping Unicode letters or digits. */
export function normalizeSpell(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

export function spellWords(spell: string): string[] {
  return normalizeSpell(spell).split('-').filter(Boolean)
}

/** Reject weak credentials; the spell is the only login factor. */
export function spellWeakness(spell: string): string | null {
  const normalized = normalizeSpell(spell)
  const words = spellWords(spell)
  if (normalized.length < MIN_LENGTH) return `A spell needs at least ${MIN_LENGTH} characters`
  if (words.length < MIN_WORDS && normalized.length < MIN_SINGLE_WORD_LENGTH) {
    return `A spell needs at least ${MIN_WORDS} words, or ${MIN_SINGLE_WORD_LENGTH} characters in one`
  }
  return null
}

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase()
}

/** Keyed lookup prevents offline guessing after a DB leak; the label separates it from AES keys. */
export async function spellHash(secret: string, spell: string): Promise<string> {
  const key = await sha256(`magicdrive:spell:v1:${secret}`)
  return toHex(await hmacSha256(key, normalizeSpell(spell)))
}
