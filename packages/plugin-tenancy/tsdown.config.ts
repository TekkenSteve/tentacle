/**
 * Client-half build (the host half is plain tsc → lib/ ESM; see the build
 * script). Produces lib/client.js: a closure-factory bundle calling
 * window.__ModuleLoader__.load({id, factory}) with platform modules left
 * external — the official client-module contract consumed by
 * dsh-client-modules (research: multi-tenant-projects-analysis §4.4, and the
 * harness's own packages/client preset). No CSS: the restricted views use
 * inline styles, so the lightningcss inline plugin from the reference config
 * is deliberately omitted.
 */
import { defineConfig, type UserConfig } from 'tsdown'

/** Plugin id stamped into the __ModuleLoader__.load handoff. */
const PLUGIN_ID = '@tentacle/tenancy'

/**
 * Externals resolved from the loader module table: the platform seed entries
 * plus the runtime packages the web shell guarantees. Everything else must
 * inline (the loader throws on a miss — the bundle purity gate).
 */
const CLIENT_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  // Official UI primitives come from the loader (same external set as the
  // channels/persona consoles).
  '@deepseek-ai/dsh-client-ui-primitives',
]

const client: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  entryFileNames: 'client.js',
  outExtensions: () => ({ js: '.js' }),
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    // everything not in the loader module table must inline
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  },
  outputOptions: {
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([client])
