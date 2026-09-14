/**
 * Regenerate the Typert artifacts (lib/typert.host.js, lib/typert.remote-client.js
 * + declarations) for this package.
 *
 * The DSH Typert generator only discovers packages referenced from a face
 * aggregate tsconfig and rooted under <workspaceRoot>/packages/, so this
 * script stages a minimal one-package workspace under .typert/ (a copy of
 * package.json + src/) and runs the generator against it. Two DSH packages
 * are staged alongside as real source copies:
 *
 * - @deepseek-ai/dsh-typert-protocol — the generator's identity checks
 *   (TypertRemoteService, @Remote) require the declaration to live in a
 *   registered workspace package, not a node_modules d.ts;
 * - @deepseek-ai/dsh-util-values — remote-boundary types (JsonValue) must be
 *   owned by a registered package for codec generation.
 *
 * Output lands in lib/ and is validated by the generator itself (export map +
 * files list). Run via `pnpm build`; safe to run alone after editing src/rpc.ts.
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const root = fileURLToPath(new URL('..', import.meta.url))
const staging = join(root, '.typert')
const require = createRequire(import.meta.url)

/** DSH packages staged as workspace source copies, with their specifier -> source paths. */
const STAGED_DSH_PACKAGES = ['@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-util-values']

const compilerOptions = {
  target: 'es2024',
  module: 'esnext',
  moduleResolution: 'bundler',
  lib: ['es2024'],
  types: ['node'],
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  noEmit: true,
  allowImportingTsExtensions: true,
  skipLibCheck: true,
  esModuleInterop: true,
}

function stagePackage(name, sourceDir) {
  const dir = join(staging, 'packages', name.split('/').pop())
  mkdirSync(dir, { recursive: true })
  cpSync(join(sourceDir, 'src'), join(dir, 'src'), { recursive: true })
  cpSync(join(sourceDir, 'package.json'), join(dir, 'package.json'))
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions, include: ['src'] }, null, 2))
  return dir
}

rmSync(staging, { recursive: true, force: true })
const paths = {}
const references = [{ path: './packages/dsh-runninghub-api' }]
stagePackage('dsh-runninghub-api', root)
for (const name of STAGED_DSH_PACKAGES) {
  const sourceDir = dirname(require.resolve(`${name}/package.json`))
  const dir = stagePackage(name, sourceDir)
  references.push({ path: `./packages/${name.split('/').pop()}` })
  paths[name] = [`./packages/${name.split('/').pop()}/src/index.ts`]
}
writeFileSync(join(staging, 'tsconfig.host.json'), JSON.stringify({
  compilerOptions: { ...compilerOptions, paths },
  files: [],
  references,
}, null, 2))

// Analyze with an explicit selection: the staged DSH packages stay registered
// (identity checks, codec ownership) but only this package's artifacts are
// emitted and validated.
const generator = new WorkspaceTypertGenerator(staging, { checkDiagnostics: false })
const artifacts = generator.generate(['dsh-runninghub-api'], ['host'])
if (artifacts.length === 0) {
  throw new Error('gen-typert: generator discovered no Typert surface for dsh-runninghub-api')
}

const lib = join(root, 'lib')
mkdirSync(lib, { recursive: true })
for (const artifact of artifacts) {
  writeFileSync(join(lib, `typert.${artifact.face}.js`), artifact.js)
  writeFileSync(join(lib, `typert.${artifact.face}.d.ts`), artifact.dts)
  if (artifact.remote !== undefined) {
    writeFileSync(join(lib, 'typert.remote-client.js'), artifact.remote.js)
    writeFileSync(join(lib, 'typert.remote-client.d.ts'), artifact.remote.dts)
    writeFileSync(join(lib, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
  }
  console.log(`gen-typert: wrote lib/typert.${artifact.face}.js${artifact.remote !== undefined ? ' + remote client' : ''}`)
}
