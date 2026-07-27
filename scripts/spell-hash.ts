/** Prints an account-recovery update using the Worker's spell hashing rules. */
import { normalizeSpell, spellHash, spellWeakness, USERNAME_PATTERN } from '../src/worker/lib/spell'

const [secret, username, ...spellParts] = process.argv.slice(2)
const spell = spellParts.join(' ')

if (!secret || !username || !spell) {
  console.error('Usage: npm run spell -- "<DATA_ENCRYPTION_KEY>" "<username>" "<the spell>"')
  process.exit(1)
}
if (!USERNAME_PATTERN.test(username.toLowerCase())) {
  console.error(`"${username}" is not a valid username: 3–24 characters, letters, digits, hyphen or underscore.`)
  process.exit(1)
}
const weakness = spellWeakness(spell)
if (weakness) {
  console.error(weakness)
  process.exit(1)
}

const hash = await spellHash(secret, spell)
const sql = `UPDATE users SET spell_hash = '${hash}', updated_at = datetime('now') WHERE username = '${username.toLowerCase()}';`

console.log(`\nspell     ${normalizeSpell(spell)}`)
console.log(`username  ${username.toLowerCase()}`)
console.log(`\n${sql}\n`)
console.log('Apply it with:')
console.log(`  npx wrangler d1 execute DB --remote --command "${sql.replaceAll('"', '\\"')}"\n`)
console.log('The spell above is the whole credential. Nothing else will open that account.')
