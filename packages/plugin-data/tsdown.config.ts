/**
 * Client-half build (mirrors @tentacle/persona/tsdown.config.ts): produces
 * lib/client.js, the closure-factory bundle calling
 * window.__ModuleLoader__.load({id, factory}) with platform modules left
 * external — the official client-module contract. No CSS: the console view
 * uses inline styles.
 */
import { defineConfig, type UserConfig } from 'tsdown'

/** Plugin id stamped into the __ModuleLoader__.load handoff. */
const PLUGIN_ID = '@tentacle/data'

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
  // The official UI primitives come from the loader, exactly as official
  // client plugins require them.
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
  alias: {
    vega: 'vega/build/vega.min.js',
    'vega-lite': 'vega-lite/build/vega-lite.min.js',
  },
  deps: {
    // everything not in the loader module table must inline
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  },
  outputOptions: {
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports; var process = { env: { NODE_ENV: "production" } };',
  },
}

export default defineConfig([client])
