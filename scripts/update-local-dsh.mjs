#!/usr/bin/env node
/**
 * One command that puts this build into the local DSH profile:
 *
 *   npm run update:dsh                 # ~/.dsh/profiles/web
 *   npm run update:dsh -- <profile>    # another profile (or $DSH_PROFILE)
 *
 * The profile normally depends on this repo through pnpm's `link:` — a symlink,
 * so building IS installing, and all that is left is proving the profile
 * resolves to the build just made. A profile holding a real copy (tarball or
 * market install) gets that copy's `lib/` and `package.json` replaced instead.
 * Either way a restart is what loads it: dsh-hmr watches the profile manifest
 * and patch files, not plugin contents.
 */
import { cpSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENTRY_FILES = ['lib/index.js', 'lib/client.js', 'lib/typert.host.js']

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const profile = resolve(process.argv[2] ?? process.env.DSH_PROFILE ?? join(homedir(), '.dsh', 'profiles', 'web'))
const installed = join(profile, 'node_modules', name)
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)

function die(message) {
  console.error(`update-local-dsh: ${message}`)
  process.exit(1)
}

function realpathOrUndefined(path) {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

const target = realpathOrUndefined(installed)
if (target === undefined) {
  die(`${profile} has no ${name} installed.\n  install it first:  dsh plugin --profile web add ${root}`)
}

const linked = target === realpathOrUndefined(root)
if (!linked) {
  for (const entry of ['lib', 'package.json']) {
    cpSync(join(root, entry), join(installed, entry), { recursive: true, force: true })
  }
  console.log(`update-local-dsh: replaced the installed copy at ${installed}`)
}

const mismatched = ENTRY_FILES.filter(file => digest(join(root, file)) !== digest(join(installed, file)))
const bundles = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dsh?.profile?.bundles ?? []

console.log(`${name} ${version} → ${profile} (${linked ? 'link' : 'copy'})`)
for (const file of ENTRY_FILES) {
  console.log(`  ${file}  ${digest(join(installed, file))}${mismatched.includes(file) ? '  MISMATCH' : ''}`)
}
if (!bundles.includes(name)) {
  console.log(`  ! the profile manifest does not list ${name} — enable it with: dsh plugin --profile web add ${root}`)
}
if (mismatched.length > 0) die(`${mismatched.join(', ')} differ from this build`)
console.log('  ok — restart the DSH profile to load it (HMR does not watch plugin lib/)')
