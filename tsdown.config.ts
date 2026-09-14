/**
 * Standalone build for the dsh-runninghub-api plugin, replicating the DSH
 * bundle contracts:
 *
 * - host half: plain ESM node module ( Typert artifacts are emitted by
 *   scripts/gen-typert.mjs before tsdown runs — the generator requires a
 *   packages/<pkg> workspace layout this flat repo does not have).
 * - client half: lazy-CJS factory artifact that hands itself to
 *   window.__ModuleLoader__.load and resolves seed-table externals through
 *   the injected require (packages/client/tsdown.client.ts in the harness
 *   repo). CSS Modules compile through lightningcss inside the bundle: each
 *   x.module.css yields its hashed class map and injects a tagged style at
 *   factory execution.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'
import ts from 'typescript'

/** The shell's frozen seed module table (packages/client/web/src/platform.ts PLATFORM_MODULES). */
const SEED_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const DECORATOR_SYNTAX = /^\s*@[A-Za-z_$][\w$]*/m

/**
 * Lower standard TC39 decorators before rolldown sees them (the
 * `@Remote` endpoints in src/rpc.ts). Mirrors the transform half of
 * @deepseek-ai/dsh-typert-generator/tsdown.
 */
function decoratorLowering() {
  return {
    name: 'dsh-decorator-lowering',
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0] ?? id
      if (!/\.[cm]?tsx?$/.test(file) || !DECORATOR_SYNTAX.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          ...(file.endsWith('x') ? { jsx: ts.JsxEmit.ReactJSX } : {}),
          sourceMap: true,
        },
      })
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

/** Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Emit one plugin-owned style injector plus the CSS Modules class map. */
function styleInjectionModule(id: string, fileId: string, css: string, classMap: Readonly<Record<string, string>>): string {
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

/** Compile x.module.css through lightningcss and inline it as a style-injecting module. */
function cssModulesInline(id: string) {
  return {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      const exportEntries = Object.entries(cssExports ?? {})
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      for (const [local, exp] of exportEntries) classMap[local] = exp.name
      return styleInjectionModule(id, fileId, code.toString(), classMap)
    },
  }
}

export default defineConfig([
  {
    // Host half: plain ESM node module. Production sections (dependencies +
    // peerDependencies) stay external and resolve at runtime from the
    // plugin's own install or the dsh installation mirror.
    name: 'dsh-runninghub-api',
    entry: { index: 'src/index.ts', types: 'src/types.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    // clean stays off: it would wipe the Typert artifacts (gen-typert.mjs,
    // runs before tsdown) that the client bundle inlines. The build script
    // removes lib/ itself.
    clean: false,
    plugins: [decoratorLowering()],
  },
  {
    // Browser half: lazy-CJS factory bundle served by the client module system.
    name: 'dsh-runninghub-api/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    sourcemap: true,
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    deps: {
      // Requested seed-table specifiers stay imports; everything else (clsx,
      // the generated /remote contribution, zod) must inline — a require()
      // the module table cannot answer is a guaranteed runtime throw.
      neverBundle: (specifier: string) => SEED_EXTERNALS.includes(specifier),
      alwaysBundle: (specifier: string) => !SEED_EXTERNALS.includes(specifier),
    },
    plugins: [cssModulesInline('dsh-runninghub-api')],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-runninghub-api", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
