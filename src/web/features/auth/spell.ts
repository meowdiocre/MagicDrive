/**
 * Spells are generated here rather than by the Worker: the secret never has to
 * travel to a server that is not going to keep it, and the account only exists
 * once the finished spell is registered.
 */
export const SPELL_WORDS = [
  'ember', 'thistle', 'lantern', 'quill', 'moth', 'cinder', 'bramble', 'hazel',
  'willow', 'raven', 'hollow', 'amber', 'mist', 'frost', 'ivy', 'birch',
  'onyx', 'opal', 'sable', 'saffron', 'tallow', 'vellum', 'wicker', 'yarrow',
  'zephyr', 'agate', 'basil', 'cedar', 'dusk', 'elder', 'fern', 'glimmer',
  'harrow', 'indigo', 'juniper', 'kestrel', 'lichen', 'marrow', 'nettle', 'oracle',
  'pewter', 'quartz', 'rune', 'sage', 'tinder', 'umber', 'vesper', 'wisp',
  'alder', 'beacon', 'candle', 'dapple', 'echo', 'feather', 'gossamer', 'heron',
  'inkwell', 'jasper', 'kindle', 'loam', 'mantle', 'nimbus', 'ochre', 'plume',
  'riddle', 'silver', 'thorn', 'urchin', 'veil', 'warden', 'yonder', 'ash',
  'bell', 'coal', 'dew', 'elm', 'flint', 'garnet', 'husk', 'iris',
  'jade', 'kelp', 'lark', 'myrrh', 'nook', 'oat', 'pine', 'quiver',
  'reed', 'salt', 'tide', 'urn', 'vine', 'wax', 'yew', 'zinc',
  'arcane', 'brew', 'chant', 'druid', 'elixir', 'familiar', 'glyph', 'hex',
  'incant', 'jinx', 'kraken', 'ley', 'mystic', 'nectar', 'omen', 'potion',
  'quest', 'ritual', 'sigil', 'talisman', 'unseen', 'vial', 'ward', 'wyrm',
  'augur', 'bane', 'charm', 'delve', 'ether', 'fable', 'gild', 'haunt',
  'idol', 'jester', 'keep', 'lore', 'moon', 'north', 'orbit', 'prism',
  'quell', 'roost', 'star', 'tome', 'unbind', 'vow', 'wander', 'yield',
  'abbey', 'brook', 'cavern', 'dell', 'ford', 'grove', 'heath', 'isle',
  'knoll', 'marsh', 'orchard', 'pier', 'quarry', 'ridge', 'spire', 'tor',
]

export const SPELL_LENGTH = 7

/** Roughly 51 bits, which the Worker's rate limit and peppered hash sit behind. */
export const SPELL_BITS = Math.log2(SPELL_WORDS.length) * SPELL_LENGTH

export function conjureSpell(): string {
  return Array.from({ length: SPELL_LENGTH }, () => SPELL_WORDS[randomBelow(SPELL_WORDS.length)]).join('-')
}

/** Rejection sampling: a plain modulo would make the first words likelier. */
function randomBelow(bound: number): number {
  const buffer = new Uint32Array(1)
  const limit = Math.floor(2 ** 32 / bound) * bound
  let value: number
  do {
    crypto.getRandomValues(buffer)
    value = buffer[0]
  } while (value >= limit)
  return value % bound
}
