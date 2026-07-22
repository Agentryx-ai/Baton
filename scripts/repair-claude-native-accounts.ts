/**
 * Audits duplicate Claude stable identities. This command is dry-run unless
 * both --apply and one --keep <stable-account-id>=<vault-account-id> per
 * stable identity duplicate plus one --keep-refresh
 * <refresh-fingerprint>=<vault-account-id> per credential duplicate are
 * supplied. A refresh group fully removed by another explicit keeper instead
 * requires --drop-refresh <refresh-fingerprint>. Apply creates a byte-for-byte
 * vault backup.
 */
import { claudeNativeAccountVault } from '../server/claude-native-runtime.ts'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const keepByAccountId: Record<string, string> = {}
const keepByRefreshFingerprint: Record<string, string> = {}
const dropRefreshFingerprints: string[] = []
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]
  if (argument === '--apply') continue
  if (argument === '--drop-refresh') {
    const fingerprint = args[index + 1]
    if (!fingerprint) throw new Error('--drop-refresh requires <refresh-fingerprint>')
    dropRefreshFingerprints.push(fingerprint)
    index += 1
    continue
  }
  if (argument !== '--keep' && argument !== '--keep-refresh') throw new Error(`Unknown argument: ${argument}`)
  const selection = args[index + 1]
  if (!selection) throw new Error(`${argument} requires <group-key>=<vault-account-id>`)
  index += 1
  const separator = selection.indexOf('=')
  if (separator <= 0 || separator === selection.length - 1) {
    throw new Error(`${argument} requires <group-key>=<vault-account-id>`)
  }
  const target = argument === '--keep' ? keepByAccountId : keepByRefreshFingerprint
  target[selection.slice(0, separator)] = selection.slice(separator + 1)
}

const result = await claudeNativeAccountVault.repairStableIdentityDuplicates({
  apply,
  keepByAccountId,
  keepByRefreshFingerprint,
  dropRefreshFingerprints,
})
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
