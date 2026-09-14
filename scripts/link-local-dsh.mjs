/**
 * Offline development bootstrap: symlink every build-time dependency from a
 * local deepseek-harness checkout into this repo's node_modules. Use when the
 * npm registry is unreachable; the canonical path is plain `pnpm install`.
 *
 *   node scripts/link-local-dsh.mjs [path-to-deepseek-harness]
 *
 * (default: /Users/lucytrump/github/deepseek-harness, or $DSH_REPO)
 */
import { createRequire } from 'node:module'
import { globSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dshRepo = resolve(process.argv[2] ?? process.env.DSH_REPO ?? '/Users/lucytrump/github/deepseek-harness')

const PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-jobs',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-typert-generator',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-util-values',
  '@types/node',
  '@types/react',
  'clsx',
  'lightningcss',
  'react',
  'tsdown',
  'typescript',
  'vitest',
  'zod',
]

// pnpm links a package only where it is consumed, so probe several anchors.
const anchors = [
  'apps/cli/package.json',
  'package.json',
  'packages/client/web/package.json',
  'packages/client/ui-primitives/package.json',
  'packages/client/ui-attachment/package.json',
  'packages/typert/generator/package.json',
].map(rel => createRequire(join(dshRepo, rel)))

function resolvePackageDir(name) {
  for (const req of anchors) {
    try {
      return dirname(req.resolve(`${name}/package.json`))
    } catch { /* exports maps may hide ./package.json — fall through */ }
    try {
      // Resolve the main entry, then walk up to the owning manifest.
      let dir = dirname(req.resolve(name))
      for (;;) {
        try {
          if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === name) return dir
        } catch { /* keep walking */ }
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    } catch { /* try the next anchor */ }
  }
  // Workspace members are never in each other's node_modules when nothing
  // consumes them; fall back to a manifest-name scan.
  for (const pattern of ['packages/*/*/package.json', 'vendor/*/package.json', 'apps/*/package.json']) {
    for (const manifestPath of globSync(join(dshRepo, pattern))) {
      if ((JSON.parse(readFileSync(manifestPath, 'utf8'))).name === name) return dirname(manifestPath)
    }
  }
  throw new Error(`link-local-dsh: cannot resolve ${name} under ${dshRepo}`)
}

let linked = 0
for (const name of PACKAGES) {
  const target = resolvePackageDir(name)
  const link = join(root, 'node_modules', name)
  mkdirSync(dirname(link), { recursive: true })
  rmSync(link, { force: true, recursive: true })
  symlinkSync(target, link, 'dir')
  linked += 1
}
mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
for (const [bin, target] of [
  ['tsdown', join('..', 'tsdown', 'dist', 'run.mjs')],
  ['tsc', join('..', 'typescript', 'bin', 'tsc')],
  ['vitest', join('..', 'vitest', 'vitest.mjs')],
]) {
  const path = join(root, 'node_modules', '.bin', bin)
  rmSync(path, { force: true, recursive: true })
  symlinkSync(target, path)
}
console.log(`link-local-dsh: linked ${linked} packages from ${dshRepo}`)
